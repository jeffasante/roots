import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSuggestions, rankHubs, isBarrelOrTypeOnly } from "./suggestions.js";
import { Tools } from "./tools.js";

function withRepo(files: Record<string, string>, run: (tools: Tools) => void): void {
  const root = mkdtempSync(join(tmpdir(), "roots-hubtest-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    run(new Tools(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

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

test("isBarrelOrTypeOnly excludes re-export barrels and type-only modules", () => {
  assert.equal(isBarrelOrTypeOnly(`export * from "./a";\nexport { b } from "./b";`), true);
  assert.equal(isBarrelOrTypeOnly(`export interface Foo { id: string }\nexport type Bar = number;`), true);
  assert.equal(isBarrelOrTypeOnly(`export function handle() { return 1; }`), false);
  assert.equal(isBarrelOrTypeOnly(`export class Server { start() {} }`), false);
});

test("rankHubs ranks the most-imported behavioral file", () => {
  withRepo(
    {
      "src/hub.ts": "export function run() { return 1; }",
      "src/a.ts": `import { run } from "./hub.js";\nrun();`,
      "src/b.ts": `import { run } from "./hub.js";\nrun();`,
      "src/c.ts": `import { run } from "./hub.js";\nrun();`,
    },
    (tools) => {
      const hubs = rankHubs(tools, tools.findByName("*"));
      assert.equal(hubs[0].file, "src/hub.ts");
      assert.equal(hubs[0].importers, 3);
    }
  );
});

test("rankHubs drops a type-only file even when it is the most imported", () => {
  withRepo(
    {
      "src/types.ts": "export interface Config { id: string }\nexport type Mode = 'a' | 'b';",
      "src/logic.ts": "export function work() { return 2; }",
      "src/a.ts": `import type { Config } from "./types.js";\nimport { work } from "./logic.js";\nwork();`,
      "src/b.ts": `import type { Config } from "./types.js";\nimport { work } from "./logic.js";\nwork();`,
      "src/c.ts": `import type { Mode } from "./types.js";`,
    },
    (tools) => {
      const hubs = rankHubs(tools, tools.findByName("*"));
      assert.ok(!hubs.some((h) => h.file === "src/types.ts"), "type-only file must be excluded");
      assert.ok(hubs.some((h) => h.file === "src/logic.ts"), "behavioral file must be kept");
    }
  );
});

test("rankHubs is cycle-safe (circular imports do not hang or self-count)", () => {
  withRepo(
    {
      "src/x.ts": `import { fromY } from "./y.js";\nexport function fromX() { return fromY(); }`,
      "src/y.ts": `import { fromX } from "./x.js";\nexport function fromY() { return 1; }`,
      "src/a.ts": `import { fromX } from "./x.js";\nfromX();`,
      "src/b.ts": `import { fromX } from "./x.js";\nfromX();`,
    },
    (tools) => {
      // Should complete without infinite loop; x is imported by y, a, b.
      const hubs = rankHubs(tools, tools.findByName("*"));
      const x = hubs.find((h) => h.file === "src/x.ts");
      assert.ok(x, "x should be ranked");
      assert.equal(x!.importers, 3);
    }
  );
});
