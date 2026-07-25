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
    maxTokens: 700,
    messages: [
      {
        role: "system",
        content: `You suggest useful code flows for a developer to explore as codemaps.
Return JSON only in this exact shape:
{"suggestions":[{"title":"short title","description":"one concrete sentence","query":"detailed codemap generation prompt"}]}
Rules:
- Return exactly 3 suggestions.
- Ground every suggestion in the actual code evidence provided (file headers, symbols, README). Do NOT describe the repo by its languages or folder names (never write things like "Python scripts in the scripts directory" or "the Rust code").
- Each suggestion must name at least one concrete file path and one real function, class, or symbol taken from the evidence, and describe a specific runtime behavior or data flow through it.
- Prefer flows a developer would actually want to trace: how a request/command is handled, how a feature works end-to-end, how a subsystem is wired — not project structure or configuration listings.
- Titles must be under 55 characters; descriptions under 120 characters.
- The "query" must instruct roots to trace a specific flow, naming the real files/symbols to start from.

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

  // 2. Headers of likely entry-point source files (breadth over depth).
  const sourceFiles = pickSourceFiles(tools);
  for (const file of sourceFiles.slice(0, 6)) {
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

/** Drop the "<n>\t" line-number prefix that readFile prepends. */
function stripLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((line) => line.replace(/^\d+\t/, ""))
    .join("\n");
}

export function parseSuggestions(content: string): CodemapSuggestion[] {
  const cleaned = extractJson(content);
  try {
    const parsed = JSON.parse(cleaned) as { suggestions?: unknown[] } | unknown[];
    const items = Array.isArray(parsed) ? parsed : parsed.suggestions;
    if (!Array.isArray(items)) return [];
    return items
      .filter(isSuggestion)
      .slice(0, 3)
      .map((item) => ({
        title: item.title.trim().slice(0, 55),
        description: item.description.trim().slice(0, 120),
        query: item.query.trim().slice(0, 600),
      }));
  } catch {
    return [];
  }
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
  return Boolean(item.title?.trim() && item.description?.trim() && item.query?.trim());
}