import type { InferenceBackend } from "./backends/types.js";
import { Tools } from "./tools.js";

export interface CodemapSuggestion {
  title: string;
  description: string;
  query: string;
}

/**
 * How deep the suggested flows should be. Higher intensity biases the model
 * toward advanced, cross-cutting flows instead of surface-level "list the
 * folders" ideas.
 */
export type SuggestionIntensity = "foundational" | "intermediate" | "advanced";

const INTENSITY_GUIDANCE: Record<SuggestionIntensity, string> = {
  foundational: `Target newcomers orienting themselves in the codebase.
- Prefer entry points, project layout, configuration, and how the app starts up.
- Keep each flow to a single subsystem; avoid deep cross-cutting concerns.`,
  intermediate: `Target a developer comfortable with the stack who wants to understand real behavior.
- Prefer end-to-end request/response paths, subsystem boundaries, and lifecycle logic.
- Each flow should span 2-3 collaborating modules.`,
  advanced: `Target a senior engineer hunting for the hardest, highest-signal flows to master.
- Prefer intricate, non-obvious execution paths: concurrency, streaming, IPC/RPC protocols, state machines, caching, error/retry handling, and cross-process boundaries.
- Each flow must trace multiple collaborating layers end-to-end and surface subtle edge cases, not surface-level structure.
- Explicitly avoid trivial "list the folders" or "explain the config" suggestions.`,
};

const INTENSITY_TEMPERATURE: Record<SuggestionIntensity, number> = {
  foundational: 0.25,
  intermediate: 0.35,
  advanced: 0.5,
};

export async function suggestCodemaps(
  backend: InferenceBackend,
  repoRoot: string,
  intensity: SuggestionIntensity = "intermediate"
): Promise<CodemapSuggestion[]> {
  const tools = new Tools(repoRoot);
  const rootEntries = tools.listDir().slice(0, 40);
  const directories = rootEntries.filter((entry) => entry.type === "dir").slice(0, 8);
  const snapshot: Record<string, unknown> = { root: rootEntries };

  for (const directory of directories) {
    try {
      snapshot[directory.name] = tools.listDir(directory.name).slice(0, 24);
    } catch {
      // A directory may disappear while the snapshot is being collected.
    }
  }

  // Real code signal: README context, key source-file headers, and concrete
  // symbol definitions. Without this the model only sees folder names and
  // produces vague, language-level guesses instead of grounded flows.
  const signal = collectRepoSignal(tools);

  const response = await backend.chat({
    jsonMode: true,
    temperature: INTENSITY_TEMPERATURE[intensity],
    maxTokens: 1600,
    messages: [
      {
        role: "system",
        content: `You suggest useful code flows for a developer to explore as codemaps.
Return JSON only in this exact shape:
{"suggestions":[{"title":"short title","description":"2-3 sentence detailed explanation","query":"detailed codemap generation prompt"}]}
Rules:
- Return exactly 3 suggestions. Always return all 3, fully formed — never stop early.
- Ground every suggestion in the actual code evidence provided (file headers, symbols, README). Do NOT describe the repo by its languages or folder names (never write things like "Python scripts in the scripts directory" or "the Rust code").
- Each suggestion must name at least one concrete file path and one real function, class, or symbol taken from the evidence, and describe a specific runtime behavior or data flow through it.
- Prefer the "structurally central files" as starting points when they fit — they are the most-imported modules and usually anchor the important flows. This is a hint, not a requirement.
- Prefer flows a developer would actually want to trace: how a request/command is handled, how a feature works end-to-end, how a subsystem is wired — not project structure or configuration listings.
- Titles must be under 55 characters.
- "description" is a rich 2-3 sentence explanation (roughly 180-300 characters): say what the flow does, which concrete files/symbols it touches, and why it is worth tracing. Be specific, not generic. Write it for a human — do NOT put the word "Query:" or a query string inside the description; the query goes in its own "query" field.
- Every file path and symbol you mention MUST appear verbatim in the provided evidence. Never invent paths or import well-known library names (e.g. do not write "datasets/io/abc.py" or "aiohappyeyeballs/types.py" unless they literally appear in the evidence).
- The "query" must instruct roots to trace a specific flow, naming the real files/symbols (from the evidence) to start from.

Difficulty for this batch (${intensity}):
${INTENSITY_GUIDANCE[intensity]}`,
      },
      {
        role: "user",
        content: `Repository file tree:\n${JSON.stringify(snapshot)}\n\nCode evidence (real files and symbols to ground your suggestions):\n${signal}`,
      },
    ],
  });

  const suggestions = parseSuggestions(response.content);
  return suggestions.length > 0 ? suggestions : fallbackSuggestions(rootEntries, directories);
}

/** File names that describe the project and make strong grounding context. */
const DOC_CANDIDATES = ["README.md", "README.rst", "README.txt", "readme.md", "ARCHITECTURE.md", "docs/README.md"];

/** Extensions worth reading for entry-point / symbol signal. */
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs",
  ".py", ".rs", ".go", ".java", ".kt",
  ".rb", ".php", ".c", ".cc", ".cpp", ".h", ".hpp", ".cs", ".swift",
]);

/** File-name hints that usually mark an entry point or core module. */
const ENTRYPOINT_HINTS = ["main", "index", "app", "server", "cli", "lib", "mod", "core", "__init__"];

/**
 * Gather concrete code evidence: a README excerpt, headers of likely
 * entry-point files, and real symbol definitions from a grep pass. This is
 * what turns vague "it uses Python and Rust" suggestions into flows anchored
 * on real files and functions.
 */
function collectRepoSignal(tools: Tools): string {
  const sections: string[] = [];
  const sourceFiles = pickSourceFiles(tools);

  // 0. Structurally central files ("hubs"). This is a PROMPT HINT only —
  // it points the model at code worth starting from. It never becomes a
  // claim in the codemap output; that path still runs through the normal
  // location/summary verification.
  const hubs = rankHubs(tools, sourceFiles);
  if (hubs.length) {
    const lines = hubs.map((h) => `${h.file} (imported by ${h.importers} file${h.importers === 1 ? "" : "s"})`);
    sections.push(
      `--- Structurally central files (start here; ranked by internal importers) ---\n${lines.join("\n")}`
    );
  }

  // 1. Project description from a README, if present.
  for (const doc of DOC_CANDIDATES) {
    try {
      const read = tools.readFile(doc, 1, 40);
      const text = stripLineNumbers(read.content).trim();
      if (text) {
        sections.push(`--- ${read.file} (excerpt) ---\n${text.slice(0, 1200)}`);
        break;
      }
    } catch {
      // No such doc; try the next candidate.
    }
  }

  // 1b. Full source-file inventory grouped by language. Without the real list
  // of files that exist, the model invents plausible-but-fake paths (e.g.
  // library names like `aiohappyeyeballs/types.py`). Giving it the actual
  // filenames is the single biggest defense against hallucinated paths.
  const inventory = buildFileInventory(sourceFiles);
  if (inventory) sections.push(inventory);

  // 2. Headers of key files: prefer the ranked hubs (behavioral, central),
  // then fall back to entry-point-named files for breadth.
  const headerTargets = dedupe([...hubs.map((h) => h.file), ...sourceFiles]).slice(0, 6);
  for (const file of headerTargets) {
    try {
      const read = tools.readFile(file, 1, 30);
      const text = stripLineNumbers(read.content).trim();
      if (text) sections.push(`--- ${read.file} (first lines) ---\n${text.slice(0, 800)}`);
    } catch {
      // File may be unreadable; skip it.
    }
  }

  // 3. Real symbol definitions across common languages.
  const symbolPattern =
    "^\\s*(export\\s+)?(async\\s+)?(function|class|interface|type|def|fn|func|struct|enum|impl|public|module)\\s+\\w";
  const seen = new Set<string>();
  const symbolLines: string[] = [];
  try {
    for (const match of tools.grep(symbolPattern)) {
      const key = `${match.file}:${match.line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      symbolLines.push(`${match.file}:${match.line}: ${match.text.trim().slice(0, 120)}`);
      if (symbolLines.length >= 40) break;
    }
  } catch {
    // grep is best-effort.
  }
  if (symbolLines.length) sections.push(`--- Symbol definitions ---\n${symbolLines.join("\n")}`);

  return sections.join("\n\n").slice(0, 6000) || "(no readable source files found)";
}

export interface Hub {
  file: string;
  importers: number;
}

/**
 * Per-language import analysis. Each parser does the same conceptual job with
 * different syntax, so hub ranking stays language-uniform and adding a new
 * language (Go, Java, …) is one more entry in LANGUAGE_PARSERS — not a fourth
 * copy of the ranking loop.
 *
 * Resolution is intentionally CHEAP and approximate: we don't fully resolve an
 * import to a byte-accurate file (sys.path / crate trees / tsconfig paths).
 * We reduce both imports and files to "module tokens" (a basename-ish key) and
 * count token matches. That's consistent with hub ranking being a *hint*, not
 * a verified fact — accuracy lives in the location_verified/summary_grounded
 * path, not here.
 */
interface LanguageParser {
  /** File extensions this parser handles (with the leading dot). */
  extensions: string[];
  /** Module tokens by which OTHER files could refer to this file. */
  fileTokens(file: string): string[];
  /** Module tokens this file imports (its dependencies). */
  importTokens(content: string): string[];
  /** True if the file is mostly re-exports or type declarations (low signal). */
  isBarrelOrTypeOnly(file: string, content: string): boolean;
}

/** The tail segment of a "/"-delimited path, lowercased, extension stripped. */
function baseNameNoExt(file: string): string {
  const base = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** The directory name containing a file (used for index/__init__/mod files). */
function parentDirName(file: string): string {
  const parts = file.split("/");
  return parts.length >= 2 ? parts[parts.length - 2].toLowerCase() : "";
}

const TS_JS_PARSER: LanguageParser = {
  extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
  fileTokens(file) {
    // A barrel index refers to its directory name; every file refers to its base.
    if (/\/index\.[cm]?[jt]sx?$/.test(file)) return [parentDirName(file), "index"];
    return [baseNameNoExt(file)];
  },
  importTokens(content) {
    const tokens: string[] = [];
    // `import ... from "x"`, `export ... from "x"`, `require("x")`.
    for (const m of content.matchAll(/(?:from|require\()\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue; // relative imports only (internal graph)
      tokens.push(baseNameNoExt(spec.replace(/\/index$/, "")) || parentDirName(spec));
    }
    return tokens;
  },
  isBarrelOrTypeOnly(_file, content) {
    const code = codeLines(content, ["//", "*", "/*"]);
    if (code.length === 0) return true;
    const reExports = code.filter((l) => /^export\s+.*\bfrom\b/.test(l) || /^export\s+\*/.test(l)).length;
    if (reExports > 0 && reExports >= code.length * 0.5) return true; // mostly a barrel
    const hasRuntime = code.some((l) => /\b(function|class)\b/.test(l) || /=>|\brequire\(/.test(l));
    const hasTypeSurface = code.some((l) => /^(export\s+)?(type|interface|enum)\b/.test(l));
    return hasTypeSurface && !hasRuntime;
  },
};

const PYTHON_PARSER: LanguageParser = {
  extensions: [".py"],
  fileTokens(file) {
    // `__init__.py` is Python's barrel: other modules import it by package name.
    if (/\/__init__\.py$/.test(file)) return [parentDirName(file)];
    return [baseNameNoExt(file)];
  },
  importTokens(content) {
    const tokens: string[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // `from x.y import z` / `from . import y` → the module segment being imported.
      let m = /^from\s+([.\w]+)\s+import\b/.exec(trimmed);
      if (m) {
        const mod = m[1].replace(/^\.+/, ""); // strip leading relative dots
        const tail = mod.split(".").filter(Boolean).pop();
        if (tail) tokens.push(tail.toLowerCase());
        continue;
      }
      // `import x.y.z` → last segment.
      m = /^import\s+([.\w]+)/.exec(trimmed);
      if (m) {
        const tail = m[1].split(".").filter(Boolean).pop();
        if (tail) tokens.push(tail.toLowerCase());
      }
    }
    return tokens;
  },
  isBarrelOrTypeOnly(file, content) {
    // A re-export `__init__.py`: mostly `from . import x` with no real bodies.
    const code = codeLines(content, ["#"]);
    if (code.length === 0) return true;
    if (/\/__init__\.py$/.test(file)) {
      const reExports = code.filter((l) => /^from\s+\.\S*\s+import\b/.test(l) || /^import\s+\./.test(l)).length;
      if (reExports > 0 && reExports >= code.length * 0.6) return true;
    }
    return false; // Python has no separate "type-only" module concept
  },
};

const RUST_PARSER: LanguageParser = {
  extensions: [".rs"],
  fileTokens(file) {
    // `mod.rs`/`lib.rs`/`main.rs` are referred to by their directory/crate.
    if (/\/(mod|lib|main)\.rs$/.test(file)) return [parentDirName(file)];
    return [baseNameNoExt(file)];
  },
  importTokens(content) {
    const tokens: string[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      // `use crate::a::b;` / `use super::foo::Bar;` → the module segment.
      const use = /^(?:pub\s+)?use\s+((?:crate|super|self)::[\w:]+)/.exec(trimmed);
      if (use) {
        const segs = use[1].split("::").filter((s) => s && !["crate", "super", "self"].includes(s));
        // The module tail (drop a trailing Type/fn name if it looks like an item).
        const mod = segs.length >= 2 ? segs[segs.length - 2] : segs[segs.length - 1];
        if (mod) tokens.push(mod.toLowerCase());
        continue;
      }
      // `mod foo;` declares a child module file `foo.rs` or `foo/mod.rs`.
      const decl = /^(?:pub\s+)?mod\s+(\w+)\s*;/.exec(trimmed);
      if (decl) tokens.push(decl[1].toLowerCase());
    }
    return tokens;
  },
  isBarrelOrTypeOnly(file, content) {
    const code = codeLines(content, ["//", "/*", "*"]);
    if (code.length === 0) return true;
    if (/\/(mod|lib)\.rs$/.test(file)) {
      // A re-export module: mostly `pub use` / `pub mod` with no fn/struct bodies.
      const reExports = code.filter((l) => /^pub\s+use\b/.test(l) || /^(pub\s+)?mod\s+\w+\s*;/.test(l)).length;
      const hasBodies = code.some((l) => /\b(fn|struct|enum|impl|trait)\b/.test(l));
      if (reExports > 0 && reExports >= code.length * 0.5 && !hasBodies) return true;
    }
    return false;
  },
};

const LANGUAGE_PARSERS: LanguageParser[] = [TS_JS_PARSER, PYTHON_PARSER, RUST_PARSER];

/** Strip blank lines and lines beginning with any of the given comment prefixes. */
function codeLines(content: string, commentPrefixes: string[]): string[] {
  return content
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !commentPrefixes.some((p) => l.startsWith(p)));
}

function parserForFile(file: string): LanguageParser | undefined {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return undefined;
  const ext = file.slice(dot).toLowerCase();
  return LANGUAGE_PARSERS.find((p) => p.extensions.includes(ext));
}

/**
 * Rank the most-imported internal files ("hubs") to hint at what is
 * structurally central. Guards against the two classic failure modes:
 *   - Barrel/type-only files (index/__init__/mod re-exports, pure type
 *     modules) are dropped so we surface behavior, not just where names live.
 *   - Only a flat importer COUNT is computed (no graph traversal), so import
 *     cycles cannot cause infinite loops.
 *
 * CYCLE-SAFETY SCOPE: the safety above comes from *counting*, not from any
 * graph property. If a future feature walks from a hub into its importers to
 * build a connected-files subgraph, that traversal MUST carry its own visited
 * set — the guarantee here does not transfer to graph walking.
 *
 * Resolution is a cheap per-language token match (see LanguageParser), not
 * full module resolution; hub ranking is a prompt hint, never a trusted claim.
 */
export function rankHubs(tools: Tools, sourceFiles: string[]): Hub[] {
  const graphable = sourceFiles.filter((file) => parserForFile(file));
  if (graphable.length === 0) return [];

  // Map each module token → the files that answer to it. Collisions across
  // directories are accepted: this is an approximate importer count by design.
  const filesByToken = new Map<string, string[]>();
  for (const file of graphable) {
    const parser = parserForFile(file)!;
    for (const token of parser.fileTokens(file)) {
      if (!token) continue;
      const bucket = filesByToken.get(token);
      if (bucket) bucket.push(file);
      else filesByToken.set(token, [file]);
    }
  }

  const importerCount = new Map<string, number>();
  const barrelOrTypeOnly = new Set<string>();

  for (const file of graphable) {
    const parser = parserForFile(file)!;
    let content: string;
    try {
      content = stripLineNumbers(tools.readFile(file).content);
    } catch {
      continue;
    }

    if (parser.isBarrelOrTypeOnly(file, content)) barrelOrTypeOnly.add(file);

    // Each importer contributes at most once per target file (dedupe targets).
    const targets = new Set<string>();
    for (const token of parser.importTokens(content)) {
      for (const target of filesByToken.get(token) ?? []) {
        if (target !== file) targets.add(target); // ignore self-imports
      }
    }
    for (const target of targets) {
      importerCount.set(target, (importerCount.get(target) ?? 0) + 1);
    }
  }

  return [...importerCount.entries()]
    .filter(([file, count]) => count >= 2 && !barrelOrTypeOnly.has(file))
    .map(([file, importers]) => ({ file, importers }))
    .sort((a, b) => (b.importers !== a.importers ? b.importers - a.importers : a.file.localeCompare(b.file)))
    .slice(0, 6);
}

/** Back-compat: content-only barrel/type-only check via the TS/JS parser. */
export function isBarrelOrTypeOnly(content: string): boolean {
  return TS_JS_PARSER.isBarrelOrTypeOnly("x.ts", content);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** Choose a handful of source files that most likely hold entry points. */
function pickSourceFiles(tools: Tools): string[] {
  let files: string[] = [];
  try {
    files = tools.findByName("*");
  } catch {
    return [];
  }
  const sources = files.filter((file) => {
    const dot = file.lastIndexOf(".");
    return dot >= 0 && SOURCE_EXTENSIONS.has(file.slice(dot).toLowerCase());
  });
  const score = (file: string): number => {
    const base = file.slice(file.lastIndexOf("/") + 1).toLowerCase();
    const stem = base.slice(0, base.lastIndexOf("."));
    const hintScore = ENTRYPOINT_HINTS.includes(stem) ? 0 : ENTRYPOINT_HINTS.some((h) => stem.includes(h)) ? 1 : 2;
    return hintScore * 100 + file.split("/").length; // prefer entry points nearer the root
  };
  return sources.sort((a, b) => score(a) - score(b));
}

/** How many files to list per language before truncating with a count. */
const INVENTORY_PER_LANGUAGE = 40;
/** Hard cap on the total inventory listing so it can't dominate the prompt. */
const INVENTORY_TOTAL_CAP = 200;

/**
 * Public entry: build the real `ls`-style source inventory for a repo. Shared
 * by the suggestion generator and the codemap research phase so both orient on
 * files that actually exist instead of guessing.
 */
export function repoFileInventory(tools: Tools): string {
  return buildFileInventory(pickSourceFiles(tools));
}

/**
 * Build a real `ls`-style inventory of the source files that actually exist,
 * grouped by extension. This is EVIDENCE, not a hint: every path the model is
 * allowed to name must appear here, which is what stops it inventing library
 * paths that aren't in the repo.
 */
function buildFileInventory(sourceFiles: string[]): string {
  if (!sourceFiles.length) return "";

  const byExt = new Map<string, string[]>();
  for (const file of sourceFiles) {
    const dot = file.lastIndexOf(".");
    const ext = dot >= 0 ? file.slice(dot).toLowerCase() : "(none)";
    const bucket = byExt.get(ext) ?? [];
    bucket.push(file);
    byExt.set(ext, bucket);
  }

  // Show the largest language groups first — they carry the core logic.
  const groups = [...byExt.entries()].sort((a, b) => b[1].length - a[1].length);

  const lines: string[] = [];
  let total = 0;
  for (const [ext, files] of groups) {
    if (total >= INVENTORY_TOTAL_CAP) break;
    const shown = files.slice(0, INVENTORY_PER_LANGUAGE);
    const remaining = files.length - shown.length;
    lines.push(`${ext} (${files.length} file${files.length === 1 ? "" : "s"}):`);
    for (const file of shown) {
      if (total >= INVENTORY_TOTAL_CAP) break;
      lines.push(`  ${file}`);
      total += 1;
    }
    if (remaining > 0 && total < INVENTORY_TOTAL_CAP) {
      lines.push(`  … ${remaining} more`);
    }
  }

  return `--- Source file inventory (real paths — only reference files from this list) ---\n${lines.join("\n")}`;
}

/** Drop the "<n>\t" line-number prefix that readFile prepends. */
function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\d+\t/, ""))
    .join("\n");
}

export function parseSuggestions(content: string): CodemapSuggestion[] {
  const cleaned = extractJson(content);
  let items: unknown[] = [];
  try {
    const parsed = JSON.parse(cleaned) as { suggestions?: unknown[] } | unknown[];
    const list = Array.isArray(parsed) ? parsed : parsed.suggestions;
    if (Array.isArray(list)) items = list;
  } catch {
    // Strict parse failed — the model most likely truncated the JSON array
    // mid-way (common on small models). Salvage every complete `{...}` object
    // so we still surface the suggestions that did finish instead of falling
    // back to the generic three.
    items = salvageSuggestionObjects(content);
  }

  return items
    .filter(isSuggestion)
    .slice(0, 3)
    .map((item) => {
      const query = item.query.trim().slice(0, 600);
      // A detailed description is what makes the card useful. If the model
      // omitted or truncated it, fall back to the query text so the card is
      // never empty rather than dropping the whole suggestion.
      const description = cleanDescription(item.description?.trim() || query).slice(0, 320);
      return {
        title: item.title.trim().slice(0, 55),
        description,
        query,
      };
    });
}

/**
 * Strip a trailing machine-facing clause the model sometimes appends to the
 * description — e.g. `... socket handling. Query: \`a.py, b.py\`` — so the card
 * shows a clean human explanation instead of a leaked query string.
 */
function cleanDescription(description: string): string {
  return description
    .replace(/\s*(?:^|[.\s])(?:query|prompt)\s*:\s*[`'"].*$/is, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Recover individual suggestion objects from a truncated / malformed JSON
 * response. Each `{...}` that balances is parsed and, if it looks like a
 * suggestion (has a title + query), kept. This works even when the objects are
 * nested inside a `{"suggestions":[ ... ]}` wrapper whose outer braces were
 * never closed because the response was cut off. A trailing incomplete object
 * is simply skipped.
 */
function salvageSuggestionObjects(content: string): unknown[] {
  const objects: unknown[] = [];
  const starts: number[] = [];
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") starts.push(index);
    else if (character === "}" && starts.length) {
      const start = starts.pop()!;
      try {
        const candidate = JSON.parse(content.slice(start, index + 1));
        if (isSuggestion(candidate)) objects.push(candidate);
      } catch {
        // Skip an object we still can't parse.
      }
    }
  }
  return objects;
}

function extractJson(content: string): string {
  const withoutFences = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const objectStart = withoutFences.indexOf("{");
  const arrayStart = withoutFences.indexOf("[");
  const start = [objectStart, arrayStart].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (start === undefined) return withoutFences;

  const opener = withoutFences[start];
  const closer = opener === "{" ? "}" : "]";
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < withoutFences.length; index++) {
    const character = withoutFences[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === opener) depth++;
    else if (character === closer && --depth === 0) return withoutFences.slice(start, index + 1);
  }
  return withoutFences.slice(start);
}

function fallbackSuggestions(
  rootEntries: { name: string; type: string }[],
  directories: { name: string; type: string }[]
): CodemapSuggestion[] {
  const directoryNames = directories.map((entry) => entry.name);
  const rootFiles = rootEntries.filter((entry) => entry.type === "file").map((entry) => entry.name).slice(0, 4);
  const primary = directoryNames[0] ?? ".";
  const secondary = directoryNames[1];
  const boundary = secondary ? `${primary} and ${secondary}` : `${primary} and the repository root`;
  const entrypoints = rootFiles.length > 0 ? rootFiles.join(", ") : "root configuration files";

  return [
    {
      title: `Trace ${primary} initialization`.slice(0, 55),
      description: `Follow startup from ${entrypoints} into ${primary}.`.slice(0, 120),
      query: `Trace how ${primary} is initialized from ${entrypoints}, including its entry points, configuration, and calls into other repository modules.`,
    },
    {
      title: "Map package boundaries",
      description: `Explain the runtime and dependency boundary between ${boundary}.`.slice(0, 120),
      query: `Map how ${boundary} interact. Identify public entry points, shared types, configuration, and the concrete call flow across the boundary.`,
    },
    {
      title: "Trace configuration flow",
      description: `Follow configuration from ${entrypoints} into runtime code.`.slice(0, 120),
      query: `Trace how configuration from ${entrypoints} is loaded, validated, and consumed by ${primary} and related modules.`,
    },
  ];
}

function isSuggestion(value: unknown): value is CodemapSuggestion {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<CodemapSuggestion>;
  // Only title + query are required. The description is nice-to-have and is
  // backfilled from the query when missing, so a suggestion with a valid title
  // and query is never discarded just because the model dropped its description.
  return Boolean(item.title?.trim() && item.query?.trim());
}