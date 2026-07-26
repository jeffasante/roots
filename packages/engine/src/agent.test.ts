import assert from "node:assert/strict";
import { test } from "node:test";
import { assessCodemapQuality, normalizeDiagram, sanitizeMermaid } from "./agent.js";
import type { DiagramEdge, Trace } from "./types.js";

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
      children: [`t${section}a`, `t${section}b`, `t${section}c`],
    });
    for (const suffix of ["a", "b", "c"]) {
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

test("quality gate rejects speculative, ungrounded narration", () => {
  const traces: Trace[] = [];
  for (let section = 1; section <= 3; section++) {
    traces.push({
      id: `t${section}`,
      title: `Phase ${section}`,
      summary: `Explains phase ${section}.`,
      locations: [location],
      children: [`t${section}a`, `t${section}b`, `t${section}c`],
    });
    for (const suffix of ["a", "b", "c"]) {
      traces.push({
        id: `t${section}${suffix}`,
        title: `Action ${section}${suffix}`,
        summary: "Explains a concrete grounded action.",
        locations: [location],
      });
    }
  }

  const overview =
    "The request enters through server registration [t1a], then truncation is likely handled downstream [t2a], and it finishes in persistence [t3b].";

  const result = assessCodemapQuality(overview, traces);
  assert.equal(result.ok, false);
  assert.ok(
    result.issues.some((issue) => issue.toLowerCase().includes("speculation")),
    "should flag the hedge phrase 'likely'"
  );
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
  assert.match(diagram.content, /t1a\["1a: Create server"\]/);
  assert.match(diagram.content, /t1a --> t1b/);
  assert.match(diagram.content, /t1b --> t2a/);
});

test("valid model Mermaid is preserved", () => {
  const content = "flowchart LR\n  t1a --> t1b";
  assert.deepEqual(normalizeDiagram({ format: "mermaid", content }, []), { format: "mermaid", content });
});

test("diagram renders subgraphs, labeled/conditional edges, and confidence styling", () => {
  // A small synthetic tree: 2 phases, 3 leaf nodes, one conditional branch,
  // one low-confidence node, one focus node.
  const verified = { location_verified: true, location_evidence: "symbol", summary_grounded: 0.9 } as const;
  const lowConf = { location_verified: true, location_evidence: "file_line", summary_grounded: 0.2 } as const;
  const traces: Trace[] = [
    { id: "t1", title: "Encoding Selection", summary: "", locations: [location], children: ["t1a", "t1b"], confidence: verified },
    { id: "t1a", title: "CLI encoding selection", summary: "", locations: [location], confidence: verified, focus: true },
    { id: "t1b", title: "Metal storage dispatch", summary: "", locations: [location], confidence: lowConf },
    { id: "t2", title: "TurboQuant", summary: "", locations: [location], children: ["t2a", "t2b"], confidence: verified },
    { id: "t2a", title: "Compress during write", summary: "", locations: [location], confidence: verified },
    { id: "t2b", title: "Store compressed block", summary: "", locations: [location], confidence: verified },
  ];
  const edges: DiagramEdge[] = [
    { from: "t1a", to: "t1b", label: "dispatches to" },
    { from: "t1b", to: "t2a", condition: "TurboQuant" },
  ];

  const diagram = normalizeDiagram(undefined, traces, edges);
  const c = diagram.content;

  // Subgraph grouping, one per top-level section.
  assert.match(c, /subgraph Section1\["1\. Encoding Selection"\]/);
  assert.match(c, /subgraph Section2\["2\. TurboQuant"\]/);
  // Step-id labels derived from tree position.
  assert.match(c, /t1a\["1a: CLI encoding selection"\]/);
  assert.match(c, /t2a\["2a: Compress during write"\]/);
  // Labeled edge and conditional edge (condition rendered as `if …`).
  assert.match(c, /t1a -->\|"dispatches to"\| t1b/);
  assert.match(c, /t1b -->\|"if TurboQuant"\| t2a/);
  // Structural flow supplements sparse semantic edges and does not duplicate
  // relationships already supplied by the model.
  assert.match(c, /t2a --> t2b/);
  assert.equal((c.match(/t1a -->/g) ?? []).length, 1);
  assert.equal((c.match(/t1b -->/g) ?? []).length, 1);
  // Confidence-aware classDefs and their assignments.
  assert.match(c, /classDef unverified/);
  assert.match(c, /class t1b unverified;/);
  assert.match(c, /classDef focus/);
  assert.match(c, /class t1a focus;/);
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