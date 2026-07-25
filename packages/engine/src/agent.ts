import type { InferenceBackend } from "./backends/types.js";
import { Tools } from "./tools.js";
import type { Codemap, Diagram, LogEntry, Trace } from "./types.js";
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
1. Orient: list the relevant directory and find the entry point(s) for the task.
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
      "locations": [ { "file": "repo/relative/path", "start_line": 15, "end_line": 18 } ]
    }
  ],
  "diagram": { "format": "mermaid", "content": "flowchart TD\\n  subgraph Section1[\"1. Section title\"]\\n    t1a[\"1a. Concrete sub-step\"] --> t1b[\"1b. Next sub-step\"]\\n  end" }
}

Rules:
- Build a TWO-LEVEL tree: 3–6 top-level sections (phases/concepts), each with 2–4 concrete child sub-steps referenced via "children" ids. Aim for 10+ total traces when the research supports it.
- Every location MUST be a real file and line range from the research log. Never invent files or lines. Point child locations at the exact function/statement (tight ranges), and section locations at the enclosing block.
- Titles: sections name a concept ("Admin Authentication Middleware"); children name a concrete action ("API key extraction from headers").
- Top-level sections should include "motivation" and "details" when the research supports them. Do not add these fields to simple child actions.
- summaries are concrete and specific to the cited code — not generic. Order sections in execution/flow order; order children in the order they run.
- Prose fields may use concise Markdown for emphasis, inline code, lists, and fenced code blocks. Do not emit raw HTML or Markdown headings.
- overview is required and must reference several trace ids in [brackets].
- diagram is required. Emit valid Mermaid flowchart TD syntax. Use one subgraph per top-level section, one node per child step, actual trace ids as node ids (for example t1a), displayed labels like "1a. Register handlers", arrows between sequential child nodes, and arrows connecting the last child of one section to the first child of the next. Do not use Mermaid click directives or HTML labels.`;

const REPAIR_SYSTEM = `${SYNTHESIS_SYSTEM}

The previous synthesis was too shallow. Replace it with a complete codemap that fixes every listed structural deficiency. Reuse only locations present in the research log; do not pad the result with invented or repetitive steps.`;

export class Agent {
  constructor(private readonly backend: InferenceBackend) {}

  async run(opts: AgentOptions): Promise<Codemap> {
    const tools = new Tools(opts.repoRoot);
    const maxSteps = opts.maxSteps ?? 14;
    const log: LogEntry[] = [];
    const history: string[] = [];

    // ---- Phase 1: research ----
    for (let step = 0; step < maxSteps; step++) {
      opts.onProgress?.({ phase: "research", message: `Researching (step ${step + 1})`, step: step + 1 });

      const res = await this.backend.chat({
        jsonMode: true,
        messages: [
          { role: "system", content: RESEARCH_SYSTEM },
          { role: "user", content: `Task: ${opts.query}` },
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

    return {
      version: CODEMAP_VERSION,
      id: makeId(opts.query),
      query: opts.query,
      overview: parsed.overview,
      created_at: new Date().toISOString(),
      model: this.backend.meta,
      repo: { root: opts.repoRoot },
      traces,
      diagram: normalizeDiagram(parsed.diagram, traces),
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
): { traces: Trace[]; diagram?: Codemap["diagram"]; overview?: string } {
  const obj = extractJson(content);
  const traces = Array.isArray(obj?.traces) ? (obj!.traces as Trace[]) : [];
  const diagram =
    obj?.diagram && typeof obj.diagram === "object"
      ? (obj.diagram as Codemap["diagram"])
      : undefined;
  const overview =
    typeof obj?.overview === "string" && obj.overview.trim() ? obj.overview.trim() : undefined;
  return { traces, diagram, overview };
}

export function normalizeDiagram(diagram: Codemap["diagram"] | undefined, traces: Trace[]): Diagram {
  const content = diagram?.format === "mermaid" ? diagram.content?.trim() : "";
  if (content && /^flowchart\s+(?:TD|TB|LR|RL|BT)\b/m.test(content)) {
    return { format: "mermaid", content };
  }
  return { format: "mermaid", content: buildMermaidDiagram(traces) };
}

function buildMermaidDiagram(traces: Trace[]): string {
  const byId = new Map(traces.map((trace) => [trace.id, trace]));
  const childIds = new Set(traces.flatMap((trace) => trace.children ?? []));
  const roots = traces.filter((trace) => !childIds.has(trace.id));
  const lines = ["flowchart TD"];
  let previousLast: string | undefined;

  roots.forEach((root, sectionIndex) => {
    const sectionLabel = sectionIndex + 1;
    const children = (root.children ?? []).map((id) => byId.get(id)).filter((trace): trace is Trace => Boolean(trace));
    const nodes = children.length > 0 ? children : [root];
    lines.push(`  subgraph Section${sectionLabel}["${sectionLabel}. ${mermaidLabel(root.title)}"]`);
    nodes.forEach((trace, stepIndex) => {
      const label = children.length > 0 ? `${sectionLabel}${String.fromCharCode(97 + stepIndex)}` : String(sectionLabel);
      lines.push(`    ${mermaidId(trace.id)}["${label}. ${mermaidLabel(trace.title)}"]`);
      if (stepIndex > 0) lines.push(`    ${mermaidId(nodes[stepIndex - 1].id)} --> ${mermaidId(trace.id)}`);
    });
    lines.push("  end");
    if (previousLast) lines.push(`  ${previousLast} --> ${mermaidId(nodes[0].id)}`);
    previousLast = mermaidId(nodes[nodes.length - 1].id);
  });

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
    }));
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
    (trace.children ?? []).filter((id) => ids.has(id)).length >= 2
  ).length;
  const grounded = traces.filter((trace) => trace.locations.length > 0).length;
  const issues: string[] = [];

  if (!overview || overview.length < 120) issues.push("Write a concrete overview of at least 2 sentences with inline [trace-id] references.");
  if (roots.length < 3) issues.push(`Create at least 3 top-level sections; found ${roots.length}.`);
  if (traces.length < 8) issues.push(`Create at least 8 total grounded nodes; found ${traces.length}.`);
  if (roots.length > 0 && rootsWithChildren / roots.length < 0.6) {
    issues.push("Give at least 60% of top-level sections two or more concrete child steps.");
  }
  if (traces.length > 0 && grounded / traces.length < 0.8) {
    issues.push("Ground at least 80% of nodes in exact locations from the research log.");
  }

  return { ok: issues.length === 0, issues };
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
