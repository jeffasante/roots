import type { InferenceBackend } from "./backends/types.js";
import { Tools } from "./tools.js";
import type { Codemap, Location, Trace } from "./types.js";

/**
 * Grounded Q&A over an existing codemap. The user asks a follow-up question
 * about the mapped area; we answer using the codemap's overview + traces as
 * context, letting the model pull in a few real file snippets before replying.
 *
 * This is deliberately lighter than the full research→synthesis agent: a short
 * read-only tool loop (read_file only) capped at a handful of steps, then one
 * answer. Answers cite locations so the UI can render clickable file:line refs.
 */

export interface AskCitation extends Location {}

export interface AskResult {
  answer: string;
  citations: AskCitation[];
}

const ASK_SYSTEM = `You are roots, a code-understanding assistant answering a follow-up question about a codebase that already has a "codemap" (a grounded map of the relevant flow).

You may take a few read-only steps to inspect real code before answering. Each turn respond with a SINGLE JSON object and nothing else:
{ "tool": "read_file", "input": { "path": string, "start"?: number, "end"?: number } }
  — read a repo-relative file (optionally a line range) to confirm details.
{ "tool": "answer", "input": { "answer": string, "citations": [ { "file": string, "start_line": number, "end_line": number } ] } }
  — give the final answer, grounded in real code. Cite the files/lines you relied on.

Rules:
- Prefer the codemap context first; only read files when you need specifics not in the map.
- Keep it to at most 3 reads, then answer.
- Be concrete and concise. Reference real symbols and files. If the answer isn't in this codebase, say so plainly.
- Format the answer with concise Markdown when useful: paragraphs, lists, bold emphasis, inline code, or fenced code blocks. Do not emit raw HTML or Markdown headings.
- Every citation MUST be a file:line range you actually saw (in the codemap or a read). Never invent paths or lines.`;

interface AskCall {
  tool: "read_file" | "answer";
  input: Record<string, unknown>;
}

/** Compact the codemap into a context block the model can reason over cheaply. */
function codemapContext(codemap: Codemap): string {
  const lines: string[] = [];
  lines.push(`Codemap: ${codemap.query}`);
  if (codemap.overview) lines.push(`Overview: ${codemap.overview}`);
  lines.push("Traces:");
  for (const t of codemap.traces) {
    lines.push(renderTraceContext(t));
  }
  return lines.join("\n");
}

function renderTraceContext(t: Trace): string {
  const loc = t.locations?.[0];
  const where = loc ? ` @ ${loc.file}:${loc.start_line}-${loc.end_line}` : "";
  const summary = t.summary ? ` — ${t.summary}` : "";
  return `- [${t.id}] ${t.title}${where}${summary}`;
}

export async function askCodemap(
  backend: InferenceBackend,
  codemap: Codemap,
  question: string,
  opts?: { maxSteps?: number },
): Promise<AskResult> {
  const tools = new Tools(codemap.repo.root);
  const maxSteps = opts?.maxSteps ?? 3;
  const history: string[] = [];
  const context = codemapContext(codemap);

  for (let step = 0; step < maxSteps; step++) {
    const res = await backend.chat({
      jsonMode: true,
      messages: [
        { role: "system", content: ASK_SYSTEM },
        { role: "user", content: `${context}\n\nQuestion: ${question}` },
        ...history.map((h) => ({ role: "assistant" as const, content: h })),
        { role: "user", content: "Next action?" },
      ],
    });

    const call = parseCall(res.content);
    if (!call) break;

    if (call.tool === "answer") {
      return {
        answer: String(call.input.answer ?? "").trim() || "I couldn't find an answer in this codebase.",
        citations: normalizeCitations(call.input.citations, tools),
      };
    }

    // read_file
    const path = typeof call.input.path === "string" ? call.input.path : undefined;
    if (!path) {
      history.push(JSON.stringify(call));
      history.push("Result: error — read_file requires a string path.");
      continue;
    }
    let out: unknown;
    try {
      out = tools.readFile(
        path,
        typeof call.input.start === "number" ? call.input.start : undefined,
        typeof call.input.end === "number" ? call.input.end : undefined,
      );
    } catch (err) {
      out = { error: err instanceof Error ? err.message : String(err) };
    }
    history.push(JSON.stringify(call));
    history.push(`Result of read_file: ${truncate(JSON.stringify(out), 3000)}`);
  }

  // Ran out of steps without an explicit answer — force a final answer.
  const final = await backend.chat({
    jsonMode: true,
    messages: [
      { role: "system", content: ASK_SYSTEM },
      { role: "user", content: `${context}\n\nQuestion: ${question}` },
      ...history.map((h) => ({ role: "assistant" as const, content: h })),
      { role: "user", content: 'Answer now with { "tool": "answer", "input": { "answer": ..., "citations": [...] } }.' },
    ],
  });
  const call = parseCall(final.content);
  if (call?.tool === "answer") {
    return {
      answer: String(call.input.answer ?? "").trim() || "I couldn't find an answer in this codebase.",
      citations: normalizeCitations(call.input.citations, tools),
    };
  }
  return { answer: final.content.trim() || "I couldn't find an answer in this codebase.", citations: [] };
}

function parseCall(raw: string): AskCall | null {
  const json = extractJson(raw);
  if (!json) return null;
  try {
    const obj = JSON.parse(json) as { tool?: string; input?: Record<string, unknown> };
    if (obj?.tool === "read_file" || obj?.tool === "answer") {
      return { tool: obj.tool, input: obj.input ?? {} };
    }
  } catch {
    /* fall through */
  }
  return null;
}

function normalizeCitations(raw: unknown, tools: Tools): AskCitation[] {
  if (!Array.isArray(raw)) return [];
  const out: AskCitation[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    const file = typeof rec.file === "string" ? rec.file : undefined;
    const start = Number(rec.start_line);
    const end = Number(rec.end_line);
    if (!file || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    if (!tools.locationExists(file, start, end)) continue;
    out.push({ file, start_line: start, end_line: end });
  }
  return out;
}

function extractJson(text: string): string | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return text.slice(start, end + 1);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + "…";
}
