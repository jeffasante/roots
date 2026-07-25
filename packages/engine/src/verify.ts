/**
 * Trace verification: the honesty backbone of roots.
 *
 * Two deliberately separate steps:
 *
 *   verifyTrace()   — deterministic, cheap, no model call. Confirms each
 *                     trace's locations actually resolve in the repo and
 *                     records HOW strongly (matched symbol vs file+line only).
 *
 *   groundingPass() — probabilistic, expensive, one model call. Scores whether
 *                     a second read of the resolved code still supports the
 *                     trace's summary. Only ever runs on a location-verified
 *                     trace — you never ground a claim against code that isn't
 *                     really there.
 *
 * They are NOT fused into one function on purpose: the eval harness runs the
 * cheap deterministic check across every backend in bulk, and only spends the
 * expensive grounding call on a sampled subset when comparing model quality.
 *
 * Integrity rule (relied on by quiz question-generation):
 *   summary_grounded is only ever set when location_verified is true.
 *   A quiz may therefore filter on `location_verified && summary_grounded > t`
 *   and trust the fields without re-checking anything itself.
 */

import type { InferenceBackend } from "./backends/types.js";
import type { Confidence, Location, Trace } from "./types.js";

/** Minimal read surface verification needs — satisfied by the existing Tools class. */
export interface LocationResolver {
  locationExists(file: string, startLine: number, endLine: number): boolean;
  readFile(
    subPath: string,
    start?: number,
    end?: number
  ): { file: string; content: string; start_line: number; end_line: number };
}

/**
 * Pass 1 — deterministic location verification. No model call.
 *
 * A trace is `location_verified` only if it has at least one location AND every
 * location it carries resolves in the repo. Evidence is upgraded to "symbol"
 * when a symbol-like token from the trace title is actually found within the
 * cited line range (a stronger signal than "the line numbers merely exist").
 */
export function verifyTrace(trace: Trace, resolver: LocationResolver): Confidence {
  const locations = Array.isArray(trace.locations) ? trace.locations : [];

  if (locations.length === 0) {
    return { location_verified: false, location_evidence: "none" };
  }

  const allResolve = locations.every((loc) =>
    resolver.locationExists(loc.file, loc.start_line, loc.end_line)
  );

  if (!allResolve) {
    return { location_verified: false, location_evidence: "none" };
  }

  const hasSymbol = locations.some((loc) => symbolPresentInRange(trace.title, loc, resolver));

  return {
    location_verified: true,
    location_evidence: hasSymbol ? "symbol" : "file_line",
  };
}

/**
 * Pass 2 — probabilistic summary grounding. One model call. Mutates the trace's
 * confidence in place. Returns early (leaving summary_grounded undefined) when
 * the location isn't verified — enforcing the integrity rule above.
 */
export async function groundingPass(
  trace: Trace,
  backend: InferenceBackend,
  resolver: LocationResolver
): Promise<void> {
  if (!trace.confidence?.location_verified) {
    return; // never ground an unverified location
  }
  const code = readLocations(trace.locations, resolver);
  if (!code.trim()) return;

  const score = await scoreClaimAgainstCode(backend, trace.summary, code);
  trace.confidence = { ...trace.confidence, summary_grounded: score };
}

/**
 * Extract symbol-like identifiers from a trace title (e.g. "Sign access + refresh
 * JWTs" → ["Sign", "access", "refresh", "JWTs"]) and check whether any appears in
 * the cited source range. Deliberately conservative: presence of ANY meaningful
 * token counts as symbol evidence. A tree-sitter/LSP resolver can later replace
 * this heuristic behind the same LocationResolver interface without changing callers.
 */
function symbolPresentInRange(title: string, loc: Location, resolver: LocationResolver): boolean {
  const tokens = title
    .split(/[^A-Za-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOP_WORDS.has(t.toLowerCase()));
  if (tokens.length === 0) return false;

  let content: string;
  try {
    content = resolver.readFile(loc.file, loc.start_line, loc.end_line).content;
  } catch {
    return false;
  }
  // readFile prefixes each line with "<n>\t"; strip those so line numbers don't
  // masquerade as symbol matches.
  const source = content.replace(/^\d+\t/gm, "");
  return tokens.some((tok) => source.includes(tok));
}

/** Concatenate the resolved source for a trace's locations, tagged by file:line. */
function readLocations(locations: Location[], resolver: LocationResolver): string {
  const parts: string[] = [];
  for (const loc of locations) {
    try {
      const { content } = resolver.readFile(loc.file, loc.start_line, loc.end_line);
      parts.push(`// ${loc.file}:${loc.start_line}-${loc.end_line}\n${content}`);
    } catch {
      // skip unreadable location; verifyTrace already gates on existence
    }
  }
  return parts.join("\n\n");
}

const GROUNDING_SYSTEM = `You are a strict code-grounding judge. Given a CLAIM about some CODE, decide how well the code supports the claim.
Respond with a single JSON object and nothing else: { "score": <number 0..1> }.
1.0 = the code fully and unambiguously supports the claim. 0.0 = the code contradicts it or is unrelated. Be conservative; when unsure, score lower.`;

/**
 * Ask a backend to score how well `code` supports `claim`. Tolerant of models
 * that wrap JSON in prose; clamps to 0..1. Kept here (not on the backend
 * interface) so every backend gets it for free and it's unit-testable with a
 * fake backend.
 */
export async function scoreClaimAgainstCode(
  backend: InferenceBackend,
  claim: string,
  code: string
): Promise<number> {
  const res = await backend.chat({
    jsonMode: true,
    temperature: 0,
    messages: [
      { role: "system", content: GROUNDING_SYSTEM },
      { role: "user", content: `CLAIM:\n${claim}\n\nCODE:\n${code}` },
    ],
  });
  return parseScore(res.content);
}

function parseScore(content: string): number {
  const match = content.match(/"score"\s*:\s*(-?\d+(?:\.\d+)?)/);
  const raw = match ? Number(match[1]) : Number.NaN;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}

const STOP_WORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "into",
  "this",
  "that",
  "via",
  "add",
  "get",
  "set",
  "run",
  "new",
  "use",
  "all",
  "any",
]);
