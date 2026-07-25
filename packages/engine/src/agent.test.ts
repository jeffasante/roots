import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCodemapQuality, normalizeDiagram, sanitizeMermaid } from "./agent.js";
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

test("diagram fallback groups sections and connects trace ids", () => {
  const traces: Trace[] = [
    { id: "t1", title: "RPC Server", summary: "", locations: [location], children: ["t1a", "t1b"] },
    { id: "t1a", title: "Create server", summary: "", locations: [location] },
    { id: "t1b", title: "Register handlers", summary: "", locations: [location] },
    { id: "t2", title: "Backend Factory", summary: "", locations: [location], children: ["t2a"] },
    { id: "t2a", title: "Initialize factory", summary: "", locations: [location] },
  ];

  const diagram = normalizeDiagram(undefined, traces);

  assert.match(diagram.content, /^flowchart TD/);
  assert.match(diagram.content, /subgraph Section1\["1\. RPC Server"\]/);
  assert.match(diagram.content, /t1a\["1a\. Create server"\]/);
  assert.match(diagram.content, /t1a --> t1b/);
  assert.match(diagram.content, /t1b --> t2a/);
});

test("valid model Mermaid is preserved", () => {
  const content = "flowchart LR\n  t1a --> t1b";
  assert.deepEqual(normalizeDiagram({ format: "mermaid", content }, []), { format: "mermaid", content });
});

test("sanitizeMermaid strips trailing whitespace after brackets", () => {
  // The exact failure mode from the reported issue: `] \n` before a newline.
  const broken = "flowchart TD\n  subgraph S[1. Init] \n    t1a[1a. Load GDN Library] \n  end";
  const fixed = sanitizeMermaid(broken)!;
  assert.ok(!/\]\s+\n/.test(fixed + "\n"), "no trailing space after a bracket");
  assert.match(fixed, /subgraph S\["1\. Init"\]/);
  assert.match(fixed, /t1a\["1a\. Load GDN Library"\]/);
});

test("sanitizeMermaid quotes unquoted bracket labels with spaces and dots", () => {
  const broken = "flowchart TD\n  subgraph MetalBackendInit[1. Metal Backend Initialization]\n    t1a[1a. Load GDN Library] --> t1b[1b. Compile GDN Kernels]\n  end";
  const fixed = sanitizeMermaid(broken)!;
  assert.match(fixed, /subgraph MetalBackendInit\["1\. Metal Backend Initialization"\]/);
  assert.match(fixed, /t1a\["1a\. Load GDN Library"\] --> t1b\["1b\. Compile GDN Kernels"\]/);
});

test("sanitizeMermaid leaves already-quoted labels untouched", () => {
  const good = 'flowchart TD\n  subgraph S["1. Init"]\n    t1a["1a. Load"] --> t1b["1b. Next"]\n  end';
  assert.equal(sanitizeMermaid(good), good);
});

test("normalizeDiagram repairs a model diagram instead of discarding it", () => {
  // Reproduces the issue payload's diagram.content shape.
  const content =
    "flowchart TD\n  subgraph MetalBackendInit[1. Metal Backend Initialization] \n    t1a[1a. Load GDN Library] --> t1b[1b. Compile GDN Kernels] \n  end\n  \n  t1b --> t2a";
  const result = normalizeDiagram({ format: "mermaid", content }, []);
  assert.match(result.content, /subgraph MetalBackendInit\["1\. Metal Backend Initialization"\]/);
  assert.ok(!/\]\s+\n/.test(result.content + "\n"), "trailing bracket whitespace removed");
  assert.ok(!/^\s*$/m.test(result.content.split("\n").slice(1).join("\n")), "no blank body lines");
});