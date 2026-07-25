/**
 * Quiz-generation tests. node:test, same zero-dep pattern as verify.test.ts.
 *
 * The point of these tests is the integrity gate: prove that a question can
 * NEVER be drawn from an unverified or ungrounded node, and that eligible nodes
 * carry their honesty signal into the Question. If this file ever goes green
 * while an unverified node produces a question, the product is broken.
 *
 * Run: npm test --workspace @roots/engine
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Codemap, Confidence, Trace } from "./types.js";
import { CODEMAP_VERSION } from "./types.js";
import { generateQuiz, isQuizEligible } from "./quiz.js";

// ---- Fixtures -------------------------------------------------------------

function trace(id: string, confidence?: Confidence): Trace {
  return {
    id,
    title: `Do thing ${id}`,
    summary: `It does thing ${id}.`,
    locations: [{ file: "src/a.ts", start_line: 1, end_line: 5 }],
    confidence,
  };
}

function codemapWith(traces: Trace[]): Codemap {
  return {
    version: CODEMAP_VERSION,
    id: "cm1",
    query: "how does thing work",
    created_at: new Date().toISOString(),
    model: { backend: "fake", model_name: "fake", mode: "local" },
    repo: { root: "/repo" },
    traces,
  };
}

const VERIFIED: Confidence = { location_verified: true, location_evidence: "file_line" };
const VERIFIED_SYMBOL: Confidence = { location_verified: true, location_evidence: "symbol" };
const UNVERIFIED: Confidence = { location_verified: false, location_evidence: "none" };

// ---- The integrity gate ---------------------------------------------------

test("unverified locations are never eligible", () => {
  assert.equal(isQuizEligible(trace("t1", UNVERIFIED)), false);
});

test("a trace with no confidence at all is never eligible", () => {
  assert.equal(isQuizEligible(trace("t1", undefined)), false);
});

test("a location-verified trace with no grounding score IS eligible", () => {
  // Grounding is an optional second pass; its absence must not block quizzing.
  assert.equal(isQuizEligible(trace("t1", VERIFIED)), true);
});

test("a grounded trace below threshold is not eligible", () => {
  const low: Confidence = { ...VERIFIED, summary_grounded: 0.3 };
  assert.equal(isQuizEligible(trace("t1", low), { groundingThreshold: 0.6 }), false);
});

test("a grounded trace at or above threshold is eligible", () => {
  const ok: Confidence = { ...VERIFIED, summary_grounded: 0.6 };
  assert.equal(isQuizEligible(trace("t1", ok), { groundingThreshold: 0.6 }), true);
});

test("requireSymbolEvidence rejects file_line-only evidence", () => {
  assert.equal(isQuizEligible(trace("t1", VERIFIED), { requireSymbolEvidence: true }), false);
  assert.equal(isQuizEligible(trace("t1", VERIFIED_SYMBOL), { requireSymbolEvidence: true }), true);
});

test("a verified trace with no locations is not eligible", () => {
  const t = trace("t1", VERIFIED);
  t.locations = [];
  assert.equal(isQuizEligible(t), false);
});

// ---- generateQuiz end-to-end ---------------------------------------------

test("generateQuiz only draws from eligible traces", () => {
  const cm = codemapWith([
    trace("t1", VERIFIED), // eligible
    trace("t2", UNVERIFIED), // filtered out
    trace("t3", undefined), // filtered out
    trace("t4", { ...VERIFIED, summary_grounded: 0.9 }), // eligible
  ]);
  const quiz = generateQuiz(cm, { groundingThreshold: 0.6 });
  assert.deepEqual(
    quiz.map((q) => q.trace_id).sort(),
    ["t1", "t4"]
  );
});

test("questions carry the node's confidence forward", () => {
  const cm = codemapWith([trace("t1", VERIFIED_SYMBOL)]);
  const [q] = generateQuiz(cm);
  assert.equal(q.confidence.location_verified, true);
  assert.equal(q.confidence.location_evidence, "symbol");
});

test("question points back to real locations for the reveal", () => {
  const cm = codemapWith([trace("t1", VERIFIED)]);
  const [q] = generateQuiz(cm);
  assert.equal(q.locations.length, 1);
  assert.match(q.answer, /src\/a\.ts:1-5/);
});

test("limit caps the number of questions", () => {
  const cm = codemapWith([
    trace("t1", VERIFIED),
    trace("t2", VERIFIED),
    trace("t3", VERIFIED),
  ]);
  assert.equal(generateQuiz(cm, { limit: 2 }).length, 2);
});
