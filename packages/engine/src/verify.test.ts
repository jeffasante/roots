/**
 * Verification-pass tests. Node's built-in test runner (node:test) — no extra
 * deps. Same pattern as the cellm JSON-consistency tests: fixed fixtures,
 * assert the invariant, keep the expensive path (grounding) behind a fake
 * backend so it never makes a real model call.
 *
 * Run: npm test --workspace @roots/engine
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { InferenceBackend, ChatRequest, ChatResponse } from "./backends/types.js";
import type { Trace } from "./types.js";
import { groundingPass, scoreClaimAgainstCode, verifyTrace, type LocationResolver } from "./verify.js";

// ---- Fixtures -------------------------------------------------------------

/** A 40-line fake file with a known symbol on line 5. */
const FAKE_FILE = "src/session.ts";
const FAKE_LINES: string[] = Array.from({ length: 40 }, (_, i) => `line ${i + 1} filler`);
FAKE_LINES[4] = "export function signJwt(claims) { return jwt.sign(claims); }"; // line 5

/** In-memory resolver satisfying LocationResolver without touching disk. */
function fixtureResolver(): LocationResolver {
  return {
    locationExists(file, startLine, endLine) {
      if (file !== FAKE_FILE) return false;
      return startLine >= 1 && endLine >= startLine && startLine <= FAKE_LINES.length;
    },
    readFile(_subPath, start, end) {
      const s = Math.max(1, start ?? 1);
      const e = Math.min(FAKE_LINES.length, end ?? FAKE_LINES.length);
      const slice = FAKE_LINES.slice(s - 1, e);
      return {
        file: FAKE_FILE,
        content: slice.map((l, i) => `${s + i}\t${l}`).join("\n"),
        start_line: s,
        end_line: e,
      };
    },
  };
}

function traceWithBadLocation(): Trace {
  return {
    id: "t1",
    title: "Sign JWT",
    summary: "Signs a JWT for the session.",
    locations: [{ file: FAKE_FILE, start_line: 9999, end_line: 9999 }], // past EOF
  };
}

function traceWithRealLocation(): Trace {
  return {
    id: "t1",
    title: "Sign JWT",
    summary: "Signs a JWT for the session.",
    locations: [{ file: FAKE_FILE, start_line: 3, end_line: 8 }], // real, but symbol not in title tokens
  };
}

function traceWithSymbolMatch(): Trace {
  return {
    id: "t1",
    title: "signJwt issues the token", // "signJwt" appears on line 5
    summary: "Signs a JWT for the session.",
    locations: [{ file: FAKE_FILE, start_line: 3, end_line: 8 }],
  };
}

/** Fake backend that returns a fixed grounding score; records if it was called. */
function fixtureBackend(score = 0.82): InferenceBackend & { called: boolean } {
  const b = {
    called: false,
    meta: { backend: "fake", model_name: "fake", mode: "local" as const },
    async chat(_req: ChatRequest): Promise<ChatResponse> {
      b.called = true;
      return { content: JSON.stringify({ score }) };
    },
  };
  return b;
}

// ---- Deterministic location verification ---------------------------------

test("location_verified is false for a fabricated line", () => {
  const c = verifyTrace(traceWithBadLocation(), fixtureResolver());
  assert.equal(c.location_verified, false);
  assert.equal(c.location_evidence, "none");
});

test("location_verified is true for a real line range", () => {
  const c = verifyTrace(traceWithRealLocation(), fixtureResolver());
  assert.equal(c.location_verified, true);
  // title tokens ("Sign", "JWT") aren't literally in the source slice → file_line
  assert.equal(c.location_evidence, "file_line");
});

test("location_evidence is 'symbol' when a title token appears in the code", () => {
  const c = verifyTrace(traceWithSymbolMatch(), fixtureResolver());
  assert.equal(c.location_verified, true);
  assert.equal(c.location_evidence, "symbol");
});

test("a trace with no locations is not verified", () => {
  const t: Trace = { id: "t1", title: "empty", summary: "", locations: [] };
  const c = verifyTrace(t, fixtureResolver());
  assert.equal(c.location_verified, false);
  assert.equal(c.location_evidence, "none");
});

// ---- Integrity rule: grounding gated on location verification ------------

test("grounding is skipped (and no model call made) when location unverified", async () => {
  const trace = traceWithBadLocation();
  trace.confidence = { location_verified: false, location_evidence: "none" };
  const backend = fixtureBackend();

  await groundingPass(trace, backend, fixtureResolver());

  assert.equal(trace.confidence.summary_grounded, undefined);
  assert.equal(backend.called, false, "must not spend a model call on an unverified location");
});

test("grounding sets summary_grounded when location is verified", async () => {
  const trace = traceWithRealLocation();
  trace.confidence = verifyTrace(trace, fixtureResolver());
  const backend = fixtureBackend(0.75);

  await groundingPass(trace, backend, fixtureResolver());

  assert.equal(trace.confidence.location_verified, true);
  assert.equal(trace.confidence.summary_grounded, 0.75);
  assert.equal(backend.called, true);
});

// ---- Score parsing / clamping --------------------------------------------

test("scoreClaimAgainstCode clamps out-of-range and non-numeric output", async () => {
  const over: InferenceBackend = {
    meta: { backend: "fake", model_name: "fake", mode: "local" },
    async chat() {
      return { content: `{"score": 1.7}` };
    },
  };
  assert.equal(await scoreClaimAgainstCode(over, "claim", "code"), 1);

  const garbage: InferenceBackend = {
    meta: { backend: "fake", model_name: "fake", mode: "local" },
    async chat() {
      return { content: "the model refused to answer" };
    },
  };
  assert.equal(await scoreClaimAgainstCode(garbage, "claim", "code"), 0);
});
