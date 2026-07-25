import assert from "node:assert/strict";
import { test } from "node:test";
import { unwrapAnswerEnvelope } from "./ask.js";

test("unwrapAnswerEnvelope returns inner answer text for a leaked tool envelope", () => {
  const envelope = JSON.stringify({
    tool: "answer",
    input: { answer: "Cellm Bindings Overview\n\nThe bindings provide an FFI.", citations: [] },
  });
  assert.equal(unwrapAnswerEnvelope(envelope), "Cellm Bindings Overview\n\nThe bindings provide an FFI.");
});

test("unwrapAnswerEnvelope leaves plain prose untouched", () => {
  const prose = "The backend factory is called in `createBackend()`.";
  assert.equal(unwrapAnswerEnvelope(prose), prose);
});

test("unwrapAnswerEnvelope tolerates trailing prose after the JSON object", () => {
  const messy = `{"tool":"answer","input":{"answer":"Done."}}\n\nHope that helps!`;
  assert.equal(unwrapAnswerEnvelope(messy), "Done.");
});

test("unwrapAnswerEnvelope unwraps an answer whose body contains braces", () => {
  const envelope = `{"tool":"answer","input":{"answer":"Use { key: value } syntax here."}}`;
  assert.equal(unwrapAnswerEnvelope(envelope), "Use { key: value } syntax here.");
});

test("unwrapAnswerEnvelope falls back to trimmed text when JSON is not an answer envelope", () => {
  const notEnvelope = `{"foo":"bar"}`;
  assert.equal(unwrapAnswerEnvelope(notEnvelope), notEnvelope);
});

test("unwrapAnswerEnvelope handles empty input", () => {
  assert.match(unwrapAnswerEnvelope(""), /couldn't find an answer/);
});
