import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCodemapQuality } from "./agent.js";
import type { Trace } from "./types.js";

const location = { file: "src/server.ts", start_line: 1, end_line: 4 };

test("quality gate rejects a shallow codemap", () => {
  const traces: Trace[] = [
    {
      id: "t1",
      title: "Server setup",
      summary: "Initializes the server.",
      locations: [location],
      children: ["t1a"],
    },
    {
      id: "t1a",
      title: "Create server",
      summary: "Binds the input and output streams.",
      locations: [location],
    },
  ];

  const result = assessCodemapQuality("Short overview.", traces);

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.includes("top-level")));
  assert.ok(result.issues.some((issue) => issue.includes("total grounded")));
});

test("quality gate accepts a grouped grounded codemap", () => {
  const traces: Trace[] = [];
  for (let section = 1; section <= 3; section++) {
    traces.push({
      id: `t${section}`,
      title: `Phase ${section}`,
      summary: `Explains phase ${section}.`,
      locations: [location],
      children: [`t${section}a`, `t${section}b`],
    });
    for (const suffix of ["a", "b"]) {
      traces.push({
        id: `t${section}${suffix}`,
        title: `Action ${section}${suffix}`,
        summary: "Explains a concrete grounded action.",
        locations: [location],
      });
    }
  }

  const overview =
    "The request enters through server registration [t1a], moves through backend construction [t2a], and finishes in verified persistence [t3b]. Each phase follows the concrete runtime path.";

  assert.deepEqual(assessCodemapQuality(overview, traces), { ok: true, issues: [] });
});