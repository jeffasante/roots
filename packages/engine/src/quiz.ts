/**
 * Active recall: the reason roots exists.
 *
 * Every other AI tool optimizes for PRODUCING an explanation. roots optimizes
 * for building the explanation into the developer's head — and the only proven
 * mechanism for that is testing recall, not re-reading. This module turns a
 * verified codemap into questions the developer answers from memory.
 *
 * The load-bearing rule (promised by verify.ts, enforced here):
 *
 *   A question is NEVER generated from a node the tool isn't sure about.
 *
 * If we quizzed a developer on a hallucinated location or an ungrounded claim,
 * we'd be training them to memorize the model's mistakes — the exact opposite
 * of the product. So question generation filters on `confidence` and refuses
 * to draw from anything that isn't location-verified (and, when grounding has
 * run, whose summary cleared the grounding threshold).
 */

import type { Codemap, Confidence, Location, Trace } from "./types.js";

/** A single active-recall prompt derived from one verified trace. */
export interface Question {
  /** The trace this question tests, so the UI can jump to it on reveal. */
  trace_id: string;
  /** What the developer is asked. */
  prompt: string;
  /** The grounded answer, revealed after they attempt recall. */
  answer: string;
  /** Real code locations backing the answer — the "receipts" on reveal. */
  locations: Location[];
  /** Why this question was allowed: carries the node's honesty signal forward. */
  confidence: Confidence;
}

export interface QuizOptions {
  /**
   * Minimum grounding score a trace's summary must have to be quizzed, WHEN a
   * grounding score exists. Traces that were never grounded are still eligible
   * on the strength of location verification alone (grounding is an optional,
   * expensive second pass — its absence is not evidence of a bad claim).
   * Default 0.6.
   */
  groundingThreshold?: number;
  /** Cap the number of questions returned. Default: no cap. */
  limit?: number;
  /**
   * Require symbol-level location evidence, not just file+line. Off by default;
   * turning it on yields fewer but higher-signal questions.
   */
  requireSymbolEvidence?: boolean;
}

const DEFAULT_GROUNDING_THRESHOLD = 0.6;

/**
 * The single integrity gate. Everything eligible for a question passes through
 * here; nothing bypasses it. Returns true only when we can honestly quiz on
 * this node.
 */
export function isQuizEligible(trace: Trace, opts: QuizOptions = {}): boolean {
  const c = trace.confidence;
  if (!c || !c.location_verified) return false;
  if (opts.requireSymbolEvidence && c.location_evidence !== "symbol") return false;

  // Grounding is optional. Only enforce the threshold when a score is present.
  if (typeof c.summary_grounded === "number") {
    const threshold = opts.groundingThreshold ?? DEFAULT_GROUNDING_THRESHOLD;
    if (c.summary_grounded < threshold) return false;
  }

  // A question needs something to ask about and somewhere to point.
  return trace.title.trim().length > 0 && trace.locations.length > 0;
}

/**
 * Generate active-recall questions from a codemap. Deterministic and model-free:
 * it reshapes already-grounded trace data into prompts, so it can run offline
 * (local-first) and costs nothing. The questions test whether the developer can
 * reconstruct WHERE something happens and WHAT it does — the two things a
 * codemap is meant to install in their head.
 */
export function generateQuiz(codemap: Codemap, opts: QuizOptions = {}): Question[] {
  const eligible = codemap.traces.filter((t) => isQuizEligible(t, opts));
  const questions = eligible.map((t) => questionFromTrace(t));
  return typeof opts.limit === "number" ? questions.slice(0, Math.max(0, opts.limit)) : questions;
}

/**
 * Turn one verified trace into a "where does this happen?" recall prompt. We ask
 * for location from the human-readable title (recall of structure) and reveal
 * the summary + real files:lines as the grounded answer. Kept intentionally
 * simple and single-type for now; richer question shapes (cloze on the summary,
 * "what calls this?") can be added without loosening the eligibility gate.
 */
function questionFromTrace(trace: Trace): Question {
  const where = trace.locations
    .map((l) => `${l.file}:${l.start_line}-${l.end_line}`)
    .join(", ");

  const answer = trace.summary.trim()
    ? `${trace.summary.trim()}\n\nLocation: ${where}`
    : `Location: ${where}`;

  return {
    trace_id: trace.id,
    prompt: `Where in the codebase does this happen: "${trace.title.trim()}"?`,
    answer,
    locations: trace.locations,
    confidence: trace.confidence!, // guaranteed by isQuizEligible
  };
}
