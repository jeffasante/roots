import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSuggestions } from "./suggestions.js";

test("parses fenced json with a suggestions object", () => {
  const content =
    "Here are some ideas:\n```json\n" +
    JSON.stringify({
      suggestions: [
        { title: "Auth flow", description: "Trace login.", query: "Trace the login flow." },
      ],
    }) +
    "\n```";

  const result = parseSuggestions(content);

  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Auth flow");
});

test("parses a bare top-level array of suggestions", () => {
  const content = JSON.stringify([
    { title: "Routing", description: "Trace routes.", query: "Trace routing." },
    { title: "Persistence", description: "Trace saves.", query: "Trace persistence." },
  ]);

  const result = parseSuggestions(content);

  assert.equal(result.length, 2);
  assert.equal(result[1].title, "Persistence");
});

test("ignores prose after a valid json object", () => {
  const content =
    JSON.stringify({
      suggestions: [{ title: "Build", description: "Trace build.", query: "Trace the build." }],
    }) + "\n\nLet me know if you want more.";

  const result = parseSuggestions(content);

  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Build");
});

test("returns nothing for output with no usable json", () => {
  assert.deepEqual(parseSuggestions("I could not analyze the repository."), []);
});
