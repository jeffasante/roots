import type { InferenceBackend } from "./backends/types.js";
import { repoFileInventory, repoRelevantFiles } from "./suggestions.js";
import { Tools } from "./tools.js";
import type { Codemap, Diagram, DiagramEdge, LogEntry, Trace } from "./types.js";
import { CODEMAP_VERSION } from "./types.js";
import { verifyTrace } from "./verify.js";

/**
 * Two-phase agent: research (read-only exploration) then synthesis (produce
 * a grounded codemap). The model drives a tool loop during research; the full
 * tool log is retained and attached to the codemap for eval/debugging.
 */

export interface AgentOptions {
  query: string;
  repoRoot: string;
  maxSteps?: number;
  /** Emitted on progress so the adapter can update status bar / tree. */
  onProgress?: (event: ProgressEvent) => void;
}

export interface ProgressEvent {
  phase: "research" | "synthesis";
  message: string;
  step?: number;
  /** The tool the agent just chose this step (grep/read_file/find/list_dir). */
  action?: string;
  /** Repo-relative file the agent is currently reading/searching, when known. */
  file?: string;
  /** A short human summary of what this step is doing, e.g. a grep pattern. */
  detail?: string;
}

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

const RESEARCH_SYSTEM = `You are roots, a code-understanding agent. Your job is to deeply research a codebase to answer a task, then produce a rich, grounded "codemap".

PHASE 1 — RESEARCH. Explore using ONLY these tools, one per turn. Respond with a single JSON object and nothing else:
{ "tool": "grep" | "find" | "list_dir" | "read_file" | "done", "input": { ... } }

Tool inputs:
- grep: { "pattern": string, "path"?: string }
- find: { "glob": string }
- list_dir: { "path"?: string }
- read_file: { "path": string, "start"?: number, "end"?: number }
- done: {}  (emit when you have enough to build a detailed codemap)

Method — trace the flow like an engineer reading the code for the first time:
1. Orient: if the inventory has a "Files matching your task" section, OPEN THOSE FILES FIRST — they are the strongest leads. Otherwise list the relevant directory and find the entry point(s) for the task.
2. Follow the call chain: from each entry point, read the actual function bodies and follow what they call, register, or dispatch to. Do not stop at the first hit.
3. Capture structure: note distinct phases/groups (e.g. "router setup", "auth middleware", "request handling") and the concrete symbols and line ranges inside each.
4. Read enough of each key function to quote a real line and explain it — confirm line numbers by reading before citing.

Rules:
- Be thorough: prefer 8–14 informative steps over 2–3 shallow ones. A good codemap has multiple grouped sections, each with 2–4 concrete sub-steps.
- Prefer targeted greps + reads over listing everything, but DO follow the chain across files.
- Emit "done" only once you can ground a grouped, multi-level map in real files+lines.`;

const SYNTHESIS_SYSTEM = `You are roots. Using the research log, produce a rich, grouped codemap as a single JSON object and nothing else.

Shape:
{
  "overview": "2-4 sentence narrative of the whole flow. Reference specific traces inline by id in square brackets, e.g. 'Requests enter through the router [t1] and pass admin auth [t2a] before reaching handlers [t3].'",
  "traces": [
    {
      "id": "t1",
      "title": "Section title (a concept/phase)",
      "summary": "1-2 sentence explanation of this group.",
      "motivation": "Why this phase exists in the architecture.",
      "details": "2-4 paragraphs explaining the implementation and how its child steps connect.",
      "locations": [ { "file": "repo/relative/path", "start_line": 12, "end_line": 40 } ],
      "children": ["t1a", "t1b"]
    },
    {
      "id": "t1a",
      "title": "Concrete sub-step",
      "summary": "What this specific code does and why it matters.",
      "locations": [ { "file": "repo/relative/path", "start_line": 15, "end_line": 18 } ],
      "focus": true
    }
  ],
  "edges": [
    { "from": "t1a", "to": "t1b", "label": "dispatches to" },
    { "from": "t1b", "to": "t2a", "label": "allocates buffers for" },
    { "from": "t1a", "to": "t3a", "condition": "if TurboQuant" }
  ]
}

Rules:
- Build a TWO-LEVEL tree: 3–6 top-level sections (phases/concepts), each with 3–5 concrete child sub-steps referenced via "children" ids. Aim for 12–18 total traces when the research supports it. A section with no children is acceptable only when the cited code is genuinely a single atomic step.
- Every location MUST be a real file and line range from the research log. Never invent files or lines. Point child locations at the exact function/statement (tight ranges), and section locations at the enclosing block.
- Titles: sections name a concept ("Admin Authentication Middleware"); children name a concrete action ("API key extraction from headers").
- Top-level sections should include "motivation" and "details" when the research supports them.
- Child steps: ALWAYS give a specific 1-2 sentence "summary" that names the exact variables/functions/branches involved and what happens to them. When a child step is non-trivial (a loop, a state mutation, a guard/validation, an error path, a resource free/allocation), also add a "details" field of 1-2 short paragraphs explaining HOW it works and the edge cases (e.g. bounds checks, double-free protection, ordering guarantees). Skip "details" only for trivial one-line steps.
- Prefer depth over breadth: it is better to fully explain a real child step (summary + details grounded in the cited lines) than to add another shallow label. Every claim in a summary/details must trace back to a location in the research log.
- summaries are concrete and specific to the cited code — not generic. Order sections in execution/flow order; order children in the order they run.
- Prose fields may use concise Markdown for emphasis, inline code, lists, and fenced code blocks. Do not emit raw HTML or Markdown headings.
- overview is required and must reference several trace ids in [brackets].
- Mark exactly one trace with "focus": true — the single node this task is most directly about, i.e. where a reader should start. Usually the first entry-point child.
- edges is required and drives the diagram. DO NOT emit a "diagram" field — the engine renders the Mermaid from your traces + edges. Instead give the real relationships:
  - Each edge connects two trace ids (from/to) that you observed a real data- or control-flow relationship between in the code.
  - "label": a concrete VERB PHRASE for what actually flows between them — "dispatches to", "allocates buffers for", "caches K in", "provides kernels for", "compresses during write". NEVER a placeholder like "connects to" or "relates to". If you cannot name a real relationship, do not emit the edge.
  - "condition": ONLY when the target runs under a specific code condition you saw (an if/match/switch/feature flag), give that condition, e.g. "if TurboQuant". Do not guess conditions.
  - Connect child steps within a section in execution order, and connect sections where one's output feeds the next. Every edge label must reference a relationship you actually found in the research log — this is a presentation of grounded flow, not a place to invent new claims.`;

const REPAIR_SYSTEM = `${SYNTHESIS_SYSTEM}

The previous synthesis was too shallow. Replace it with a complete codemap that fixes every listed structural deficiency. Reuse only locations present in the research log; do not pad the result with invented or repetitive steps.`;

export class Agent {
  constructor(private readonly backend: InferenceBackend) {}

  async run(opts: AgentOptions): Promise<Codemap> {
    const tools = new Tools(opts.repoRoot);
    const maxSteps = opts.maxSteps ?? 14;
    const log: LogEntry[] = [];
    const history: string[] = [];

    // Orient the model on the files that ACTUALLY exist before it starts
    // reading. Without this it guesses plausible-but-fake paths (library names,
    // wrong extensions) and burns research steps on read errors. Passing the
    // query pins task-relevant files (even deep ones) to the top so a small
    // model traverses the right files instead of whatever fits under the cap.
    const inventory = repoFileInventory(tools, opts.query);
    const taskContext = inventory
      ? `Task: ${opts.query}\n\n${inventory}\n\nOnly read/grep files that appear in the inventory above.`
      : `Task: ${opts.query}`;

    // Prime research with real code from the strongest path matches. Small
    // models can ignore even an excellent inventory on their first turn; this
    // deterministic evidence ensures synthesis sees the likely owning files
    // and gives the model concrete symbols to follow across the call chain.
    for (const file of repoRelevantFiles(tools, opts.query)) {
      const result = tools.readFile(file, 1, 180);
      log.push({ tool: "read_file", input: { path: file, start: 1, end: 180 }, output: result, ts: now() });
      history.push(JSON.stringify({ tool: "read_file", input: { path: file, start: 1, end: 180 } }));
      history.push(`Pre-read query-matched file: ${truncate(JSON.stringify(result), 3000)}`);
    }

    // ---- Phase 1: research ----
    for (let step = 0; step < maxSteps; step++) {
      opts.onProgress?.({ phase: "research", message: `Researching (step ${step + 1})`, step: step + 1 });

      const res = await this.backend.chat({
        jsonMode: true,
        messages: [
          { role: "system", content: RESEARCH_SYSTEM },
          { role: "user", content: taskContext },
          ...history.map((h) => ({ role: "assistant" as const, content: h })),
          { role: "user", content: "Next action?" },
        ],
      });

      const call = parseToolCall(res.content);
      if (!call || call.tool === "done") {
        log.push({ tool: "done", input: {}, ts: now() });
        break;
      }

      opts.onProgress?.({
        phase: "research",
        step: step + 1,
        message: describeAction(call),
        action: call.tool,
        file: optStr(call.input.path) ?? optStr(call.input.glob),
        detail: describeDetail(call),
      });

      const result = this.executeTool(tools, call);
      log.push({ tool: call.tool, input: call.input, output: result.output, error: result.error, ts: now() });
      history.push(JSON.stringify(call));
      history.push(
        `Result of ${call.tool}: ${truncate(JSON.stringify(result.output ?? result.error ?? null), 2000)}`
      );
    }

    // ---- Phase 2: synthesis ----
    opts.onProgress?.({ phase: "synthesis", message: "Synthesizing codemap" });
    const synth = await this.backend.chat({
      jsonMode: true,
      messages: [
        { role: "system", content: SYNTHESIS_SYSTEM },
        { role: "user", content: `Task: ${opts.query}\n\nResearch log:\n${truncate(history.join("\n"), 20000)}` },
      ],
    });

    let parsed = parseSynthesis(synth.content);
    let sanitized = sanitizeTraces(parsed.traces, tools);
    const quality = assessCodemapQuality(parsed.overview, sanitized);

    if (!quality.ok) {
      opts.onProgress?.({ phase: "synthesis", message: "Expanding shallow codemap" });
      const repair = await this.backend.chat({
        jsonMode: true,
        messages: [
          { role: "system", content: REPAIR_SYSTEM },
          {
            role: "user",
            content: `Task: ${opts.query}\n\nDeficiencies:\n- ${quality.issues.join("\n- ")}\n\nPrevious synthesis:\n${truncate(synth.content, 12000)}\n\nResearch log:\n${truncate(history.join("\n"), 20000)}`,
          },
        ],
      });
      const repaired = parseSynthesis(repair.content);
      const repairedTraces = sanitizeTraces(repaired.traces, tools);
      if (codemapQualityScore(repaired.overview, repairedTraces) > codemapQualityScore(parsed.overview, sanitized)) {
        parsed = repaired;
        sanitized = repairedTraces;
      }
    }

    // Deterministic verification pass — stamps each trace's location confidence
    // with no model call. Grounding (the probabilistic pass) is intentionally
    // NOT run here; callers invoke groundingPass() on a sampled subset.
    const traces = sanitized.map((t) => ({ ...t, confidence: verifyTrace(t, tools) }));
    const edges = sanitizeEdges(parsed.edges, traces);

    return {
      version: CODEMAP_VERSION,
      id: makeId(opts.query),
      query: opts.query,
      overview: parsed.overview,
      created_at: new Date().toISOString(),
      model: this.backend.meta,
      repo: { root: opts.repoRoot },
      traces,
      edges,
      diagram: normalizeDiagram(parsed.diagram, traces, edges),
      log,
    };
  }

  private executeTool(tools: Tools, call: ToolCall): { output?: unknown; error?: string } {
    try {
      switch (call.tool) {
        case "grep":
          return { output: tools.grep(String(call.input.pattern ?? ""), optStr(call.input.path)) };
        case "find":
          return { output: tools.findByName(String(call.input.glob ?? "")) };
        case "list_dir":
          return { output: tools.listDir(optStr(call.input.path)) };
        case "read_file":
          return {
            output: tools.readFile(
              String(call.input.path ?? ""),
              optNum(call.input.start),
              optNum(call.input.end)
            ),
          };
        default:
          return { error: `Unknown tool: ${call.tool}` };
      }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }
}

function parseToolCall(content: string): ToolCall | null {
  const obj = extractJson(content);
  if (obj && typeof obj.tool === "string") {
    return { tool: obj.tool, input: (obj.input as Record<string, unknown>) ?? {} };
  }
  return null;
}

function parseSynthesis(
  content: string
): { traces: Trace[]; edges: DiagramEdge[]; diagram?: Codemap["diagram"]; overview?: string } {
  const obj = extractJson(content);
  const traces = Array.isArray(obj?.traces) ? (obj!.traces as Trace[]) : [];
  const edges = Array.isArray(obj?.edges) ? (obj!.edges as DiagramEdge[]) : [];
  const diagram =
    obj?.diagram && typeof obj.diagram === "object"
      ? (obj.diagram as Codemap["diagram"])
      : undefined;
  const overview =
    typeof obj?.overview === "string" && obj.overview.trim() ? obj.overview.trim() : undefined;
  return { traces, edges, diagram, overview };
}

/**
 * Produce the diagram for a codemap. The engine — not the model — owns diagram
 * structure and styling: grouping into subgraphs, stable step ids, labeled
 * edges, and confidence-aware classes are all derived here from the trace tree,
 * the (already grounded) edge labels, and the verification confidence stamped
 * on each trace. This keeps diagram generation a pure PRESENTATION step,
 * separate from the grounding pass, and guarantees a valid Mermaid string.
 *
 * A raw model-authored Mermaid string is still accepted for backward
 * compatibility (older callers/tests pass one), but the structured builder is
 * preferred whenever traces are available.
 */
export function normalizeDiagram(
  diagram: Codemap["diagram"] | undefined,
  traces: Trace[],
  edges: DiagramEdge[] = []
): Diagram {
  if (traces.length > 0) {
    const built = buildMermaidDiagram(traces, edges);
    assertValidMermaid(built); // fail loudly here, not silently in the webview
    return { format: "mermaid", content: built };
  }
  // Legacy path: no traces to build from, so lean on a model-authored diagram.
  const raw = diagram?.format === "mermaid" ? diagram.content?.trim() : "";
  if (raw && /^flowchart\s+(?:TD|TB|LR|RL|BT)\b/m.test(raw)) {
    const cleaned = sanitizeMermaid(raw);
    if (cleaned) return { format: "mermaid", content: cleaned };
  }
  return { format: "mermaid", content: buildMermaidDiagram(traces, edges) };
}

/**
 * Structural validity gate for generated Mermaid. A malformed diagram must fail
 * at synthesis time, where it can be caught, not be silently persisted into the
 * `.codemap` and blow up the webview render later. This is intentionally cheap
 * and structural (balanced subgraph/end, a header, no empty node ids) — full
 * grammar validation happens in the renderer.
 */
export function assertValidMermaid(content: string): void {
  const lines = content.split("\n");
  if (!/^flowchart\s+(?:TD|TB|LR|RL|BT)\b/.test(lines[0] ?? "")) {
    throw new Error(`Generated diagram is not a flowchart: ${lines[0] ?? "<empty>"}`);
  }
  let depth = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^subgraph\b/.test(trimmed)) depth++;
    else if (trimmed === "end") depth--;
    if (depth < 0) throw new Error("Generated diagram has an unmatched `end`");
    if (/\[\s*""?\s*\]/.test(trimmed)) throw new Error(`Generated diagram has an empty node label: ${trimmed}`);
  }
  if (depth !== 0) throw new Error(`Generated diagram has ${depth} unclosed subgraph(s)`);
}

/**
 * Repair the small set of Mermaid mistakes models reliably make, so a valid
 * codemap isn't thrown away over cosmetic syntax. Returns undefined only if
 * the result no longer looks like a flowchart (then we fall back to the
 * deterministic builder).
 *
 * Fixes, in order:
 *   1. Trailing whitespace after `]`/`)`/text — Mermaid's `subgraph` grammar is
 *      whitespace-sensitive and `] \n` is a hard parse error.
 *   2. Unquoted bracket labels containing spaces/dots/punctuation — e.g.
 *      `subgraph S[1. Metal Backend]` or `t1a[1a. Load GDN Library]` must be
 *      `["…"]` or Mermaid rejects them. Already-quoted labels are left alone.
 *   3. Blank lines inside the graph body, which some renderers dislike.
 */
export function sanitizeMermaid(content: string): string | undefined {
  const lines = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/, "")) // fix (1): kill trailing whitespace
    .filter((line, i) => i === 0 || line.trim() !== ""); // fix (3): drop blank body lines

  const quoted = lines.map((line) => quoteBracketLabels(line));
  const result = quoted.join("\n").trim();
  return /^flowchart\s+(?:TD|TB|LR|RL|BT)\b/m.test(result) ? result : undefined;
}

/**
 * Wrap `[label]` / `(label)` / `{label}` node text in quotes when it contains
 * characters Mermaid can't parse bare (spaces, dots, punctuation) and isn't
 * already quoted. Leaves shape delimiters and already-quoted labels intact.
 */
function quoteBracketLabels(line: string): string {
  // Matches an id followed by an opening shape delimiter and its label:
  //   subgraph Foo[1. Bar]   |   t1a[1a. Load]   |   n(round)   |   d{decision}
  return line.replace(
    /([A-Za-z_][\w]*\s*)([\[\(\{])([^"\]\)\}][^\]\)\}]*)([\]\)\}])/g,
    (whole, prefix, open, label, close) => {
      const trimmed = label.trim();
      if (trimmed.startsWith('"') && trimmed.endsWith('"')) return whole; // already quoted
      const needsQuoting = /[^\w]/.test(trimmed); // spaces, dots, punctuation, etc.
      return needsQuoting ? `${prefix}${open}"${trimmed}"${close}` : whole;
    }
  );
}

/**
 * The stable, human-facing step id for a node derived from its position in the
 * trace tree (section number + child letter): `1a`, `1b`, `2a`. This is a
 * display id only — the trace's UUID stays the identity in the `.codemap`. Kept
 * separate so re-ordering never changes a trace's identity, only its label.
 */
interface StepInfo {
  /** 1-based index of the enclosing top-level section. */
  section: number;
  /** Display id: `2` for a bare section node, `2a`/`2b` for children. */
  stepId: string;
}

function computeStepIds(roots: Trace[], byId: Map<string, Trace>): Map<string, StepInfo> {
  const steps = new Map<string, StepInfo>();
  roots.forEach((root, sectionIndex) => {
    const section = sectionIndex + 1;
    const children = (root.children ?? [])
      .map((id) => byId.get(id))
      .filter((t): t is Trace => Boolean(t));
    if (children.length > 0) {
      steps.set(root.id, { section, stepId: String(section) });
      children.forEach((child, i) => {
        steps.set(child.id, { section, stepId: `${section}${String.fromCharCode(97 + i)}` });
      });
    } else {
      steps.set(root.id, { section, stepId: String(section) });
    }
  });
  return steps;
}

/** A node is "unverified" when the deterministic pass could not confirm its
 * location, or grounding scored it low. Rendered with a dashed border so a
 * reader can see at a glance which parts of the map to trust less. */
function isUnverified(trace: Trace): boolean {
  const c = trace.confidence;
  if (!c) return true; // no verification recorded → treat as unverified
  if (!c.location_verified) return true;
  if (typeof c.summary_grounded === "number" && c.summary_grounded < 0.5) return true;
  return false;
}

/** Sanitize a model-supplied edge label/condition for use inside `-->|"…"|`. */
function edgeLabel(edge: DiagramEdge): string | undefined {
  const text = edge.condition ? `if ${edge.condition.replace(/^if\s+/i, "")}` : edge.label;
  if (!text) return undefined;
  return mermaidLabel(text);
}

function buildMermaidDiagram(traces: Trace[], edges: DiagramEdge[] = []): string {
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  const childIds = new Set(traces.flatMap((trace) => trace.children ?? []));
  const roots = traces.filter((trace) => !childIds.has(trace.id));
  const steps = computeStepIds(roots, byId);

  const lines = ["flowchart TD"];
  const unverified: string[] = [];
  const focus: string[] = [];
  const phaseAssignments: Array<{ id: string; phase: number }> = [];

  roots.forEach((root, sectionIndex) => {
    const section = sectionIndex + 1;
    const children = (root.children ?? [])
      .map((id) => byId.get(id))
      .filter((t): t is Trace => Boolean(t));
    const nodes = children.length > 0 ? children : [root];

    lines.push(`  subgraph Section${section}["${section}. ${mermaidLabel(root.title)}"]`);
    nodes.forEach((trace) => {
      const id = mermaidId(trace.id);
      const step = steps.get(trace.id)?.stepId ?? String(section);
      lines.push(`    ${id}["${step}: ${mermaidLabel(trace.title)}"]`);
      phaseAssignments.push({ id, phase: section });
      if (isUnverified(trace)) unverified.push(id);
      if (trace.focus) focus.push(id);
    });
    lines.push("  end");
  });

  // Edges. Prefer the model's grounded relationships; if none were supplied,
  // fall back to a simple sequential flow so a diagram still renders.
  const drawn = new Set<string>();
  const emit = (from: string, to: string, label?: string) => {
    const key = `${from}->${to}`;
    if (drawn.has(key)) return;
    drawn.add(key);
    lines.push(label ? `  ${from} -->|"${label}"| ${to}` : `  ${from} --> ${to}`);
  };

  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    emit(mermaidId(edge.from), mermaidId(edge.to), edgeLabel(edge));
  }

  // Always complete the semantic edges with structural execution order. Small
  // models often find a few excellent labeled relationships but omit the rest;
  // dropping this fallback whenever one edge exists leaves a sparse, fragmented
  // diagram. `emit` de-duplicates relationships already supplied by the model.
  let previousLast: string | undefined;
  roots.forEach((root) => {
    const children = (root.children ?? [])
      .map((id) => byId.get(id))
      .filter((t): t is Trace => Boolean(t));
    const nodes = children.length > 0 ? children : [root];
    nodes.forEach((trace, i) => {
      if (i > 0) emit(mermaidId(nodes[i - 1].id), mermaidId(trace.id));
    });
    if (previousLast) emit(previousLast, mermaidId(nodes[0].id));
    previousLast = mermaidId(nodes[nodes.length - 1].id);
  });

  // Phase fills give each section a distinct, muted background so groups read
  // as groups. Palette is restrained per the project's UI direction.
  const phaseColors = ["#26339F", "#020C8D", "#3B4BC0", "#5A67D8", "#7C89E8", "#9AA5F0"];
  const usedPhases = [...new Set(phaseAssignments.map((p) => p.phase))];
  for (const phase of usedPhases) {
    const color = phaseColors[(phase - 1) % phaseColors.length];
    lines.push(`  classDef phase${phase} fill:${color},stroke:${color},color:#FFFFFF;`);
  }
  for (const { id, phase } of phaseAssignments) {
    lines.push(`  class ${id} phase${phase};`);
  }

  // Confidence-aware overrides applied last so they win over the phase fill:
  //  - unverified: dashed border, signalling "trust this less".
  //  - focus: gold accent border on the single entry-point node.
  if (unverified.length > 0) {
    lines.push("  classDef unverified stroke-dasharray:4 3,stroke:#EA3D27;");
    lines.push(`  class ${unverified.join(",")} unverified;`);
  }
  if (focus.length > 0) {
    lines.push("  classDef focus stroke:#F5A623,stroke-width:3px;");
    lines.push(`  class ${focus.join(",")} focus;`);
  }

  return lines.join("\n");
}

function mermaidId(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z_]/.test(safe) ? safe : `trace_${safe}`;
}

function mermaidLabel(value: string): string {
  return value.replace(/["\n\r]/g, " ").replace(/\s+/g, " ").trim();
}

/** Drop hallucinated locations so the artifact stays grounded and schema-valid. */
function sanitizeTraces(traces: Trace[], tools: Tools): Trace[] {
  return traces
    .filter((t) => t && typeof t.id === "string" && typeof t.title === "string")
    .map((t) => ({
      id: String(t.id),
      title: String(t.title),
      summary: String(t.summary ?? ""),
      motivation: typeof t.motivation === "string" && t.motivation.trim() ? t.motivation.trim() : undefined,
      details: typeof t.details === "string" && t.details.trim() ? t.details.trim() : undefined,
      locations: (Array.isArray(t.locations) ? t.locations : [])
        .filter(
          (l) =>
            l &&
            typeof l.file === "string" &&
            Number.isFinite(l.start_line) &&
            Number.isFinite(l.end_line) &&
            tools.locationExists(l.file, l.start_line, l.end_line)
        )
        .map((l) => ({
          file: l.file,
          start_line: Math.max(1, Math.floor(l.start_line)),
          end_line: Math.max(Math.floor(l.start_line), Math.floor(l.end_line)),
        })),
      children: Array.isArray(t.children) ? t.children.map(String) : undefined,
      focus: t.focus === true ? true : undefined,
    }));
}

/**
 * Keep only edges that connect two real, distinct traces and carry a concrete
 * relationship (a label or a condition). Placeholder labels like "connects to"
 * are dropped: an edge with nothing real to say shouldn't be drawn. Edges are a
 * presentation of already-grounded flow, so no model/verification pass runs on
 * them here — only structural validity is enforced.
 */
const PLACEHOLDER_LABELS = new Set(["connects to", "relates to", "related to", "links to", "goes to", "next"]);

function sanitizeEdges(edges: DiagramEdge[], traces: Trace[]): DiagramEdge[] {
  const ids = new Set(traces.map((t) => t.id));
  const seen = new Set<string>();
  const clean: DiagramEdge[] = [];
  for (const e of Array.isArray(edges) ? edges : []) {
    if (!e || typeof e.from !== "string" || typeof e.to !== "string") continue;
    if (e.from === e.to || !ids.has(e.from) || !ids.has(e.to)) continue;
    const condition = typeof e.condition === "string" && e.condition.trim() ? e.condition.trim() : undefined;
    const rawLabel = typeof e.label === "string" ? e.label.trim() : "";
    const label = rawLabel && !PLACEHOLDER_LABELS.has(rawLabel.toLowerCase()) ? rawLabel : undefined;
    if (!label && !condition) continue; // nothing real to say → don't draw it
    const key = `${e.from}->${e.to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push({ from: e.from, to: e.to, label, condition });
  }
  return clean;
}

interface CodemapQuality {
  ok: boolean;
  issues: string[];
}

/** Structural quality gate that catches valid-but-unhelpfully-shallow model output. */
export function assessCodemapQuality(overview: string | undefined, traces: Trace[]): CodemapQuality {
  const ids = new Set(traces.map((trace) => trace.id));
  const childIds = new Set(traces.flatMap((trace) => trace.children ?? []).filter((id) => ids.has(id)));
  const roots = traces.filter((trace) => !childIds.has(trace.id));
  const rootsWithChildren = roots.filter((trace) =>
    (trace.children ?? []).filter((id) => ids.has(id)).length >= 3
  ).length;
  const grounded = traces.filter((trace) => trace.locations.length > 0).length;
  const issues: string[] = [];

  if (!overview || overview.length < 120) issues.push("Write a concrete overview of at least 2 sentences with inline [trace-id] references.");
  if (roots.length < 3) issues.push(`Create at least 3 top-level sections; found ${roots.length}.`);
  if (traces.length < 12) issues.push(`Create at least 12 total grounded nodes; found ${traces.length}.`);
  if (roots.length > 0 && rootsWithChildren / roots.length < 0.6) {
    issues.push("Give at least 60% of top-level sections three or more concrete child steps.");
  }
  if (traces.length > 0 && grounded / traces.length < 0.8) {
    issues.push("Ground at least 80% of nodes in exact locations from the research log.");
  }

  const speculative = findSpeculativePhrase(overview, traces);
  if (speculative) {
    issues.push(
      `Remove speculation ("${speculative}"). Describe only what the research log proves; ` +
        "if a step is not shown by a read/grep result, do not include it."
    );
  }

  return { ok: issues.length === 0, issues };
}

/** Hedge phrases that betray a hallucinated step rather than grounded evidence. */
const SPECULATIVE_PATTERNS: RegExp[] = [
  /\blikely\b/i,
  /\bprobably\b/i,
  /\bpresumably\b/i,
  /\bappears? to\b/i,
  /\bseems? to\b/i,
  /\bmight\b/i,
  /\bmay (?:be|handle|contain)\b/i,
  /\bnot explicitly (?:mentioned|shown|defined)\b/i,
  /\bwould (?:be|likely)\b/i,
  /\bassum(?:e|ing|ed)\b/i,
];

/** Return the first speculative phrase found in the overview or any trace text. */
function findSpeculativePhrase(overview: string | undefined, traces: Trace[]): string | null {
  const haystacks = [
    overview ?? "",
    ...traces.flatMap((t) => [t.title, t.summary, t.motivation ?? "", t.details ?? ""]),
  ];
  for (const text of haystacks) {
    for (const pattern of SPECULATIVE_PATTERNS) {
      const match = text.match(pattern);
      if (match) return match[0];
    }
  }
  return null;
}

function codemapQualityScore(overview: string | undefined, traces: Trace[]): number {
  const quality = assessCodemapQuality(overview, traces);
  const grounded = traces.filter((trace) => trace.locations.length > 0).length;
  return (quality.ok ? 1000 : 0) - quality.issues.length * 100 + traces.length * 3 + grounded;
}

/** Tolerant JSON extraction: handles fenced blocks and surrounding prose. */
function extractJson(content: string): Record<string, unknown> | null {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Human-readable one-liner for the current research step (for the progress UI). */
function describeAction(call: ToolCall): string {
  const path = optStr(call.input.path);
  const glob = optStr(call.input.glob);
  const pattern = optStr(call.input.pattern);
  switch (call.tool) {
    case "read_file":
      return path ? `Reading ${baseName(path)}` : "Reading a file";
    case "grep":
      return pattern ? `Searching for "${pattern}"` : "Searching the repository";
    case "find":
      return glob ? `Finding ${glob}` : "Finding files";
    case "list_dir":
      return path ? `Listing ${path}` : "Listing the repository root";
    default:
      return "Researching";
  }
}

/** Secondary detail (path/pattern) surfaced under the action label. */
function describeDetail(call: ToolCall): string | undefined {
  const path = optStr(call.input.path);
  const pattern = optStr(call.input.pattern);
  if (call.tool === "read_file") return path;
  if (call.tool === "grep") return path ? `${pattern} in ${path}` : pattern;
  return undefined;
}

function baseName(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

function optStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function optNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…[truncated]" : s;
}
function now(): string {
  return new Date().toISOString();
}
function makeId(query: string): string {
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const date = new Date().toISOString().slice(0, 10);
  return `${slug || "codemap"}-${date}`;
}
