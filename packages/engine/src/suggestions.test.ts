import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSuggestions, rankHubs, isBarrelOrTypeOnly, repoFileInventory } from "./suggestions.js";
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

test("keeps a suggestion missing its description, backfilling from the query", () => {
  const content = JSON.stringify({
    suggestions: [{ title: "Startup flow", query: "Trace startup from main.rs into the runtime." }],
  });

  const result = parseSuggestions(content);

  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Startup flow");
  assert.equal(result[0].description, "Trace startup from main.rs into the runtime.");
});

test("salvages complete suggestions from a truncated json array", () => {
  // Third object is cut off mid-string, so strict JSON.parse fails; the first
  // two complete objects must still be recovered.
  const truncated =
    '{"suggestions":[' +
    '{"title":"Auth flow","description":"Trace login through auth.ts.","query":"Trace the login flow from auth.ts."},' +
    '{"title":"Routing","description":"Trace routes in router.ts.","query":"Trace routing from router.ts."},' +
    '{"title":"Persistence","description":"Trace save';

  const result = parseSuggestions(truncated);

  assert.equal(result.length, 2);
  assert.equal(result[0].title, "Auth flow");
  assert.equal(result[1].title, "Routing");
});

test("strips a leaked 'Query:' clause from the description", () => {
  const content = JSON.stringify({
    suggestions: [
      {
        title: "Paged KV Cache",
        description:
          "Explore the paged KV cache in `kv_cache.rs`, tracing allocation flows. Query: `kv_cache.rs, main.rs`",
        query: "Trace the paged KV cache from kv_cache.rs.",
      },
    ],
  });

  const result = parseSuggestions(content);

  assert.equal(result.length, 1);
  assert.ok(!/query\s*:/i.test(result[0].description), "description should not contain a Query: clause");
  assert.ok(result[0].description.startsWith("Explore the paged KV cache"));
});

test("keeps a detailed multi-sentence description up to the cap", () => {
  const longDescription =
    "Trace how the request handler in server.ts dispatches to the codemap agent. " +
    "It starts at handleRequest, resolves the backend, then walks agent.run() which " +
    "collects traces and synthesizes the final diagram. Worth tracing to understand the core loop.";
  const content = JSON.stringify({
    suggestions: [{ title: "Request handling", description: longDescription, query: "Trace request handling." }],
  });

  const result = parseSuggestions(content);

  assert.equal(result.length, 1);
  assert.ok(result[0].description.length > 120, "description keeps more than the old 120-char cap");
  assert.ok(result[0].description.length <= 320, "description respects the 320-char cap");
});

test("isBarrelOrTypeOnly excludes re-export barrels and type-only modules", () => {
  assert.equal(isBarrelOrTypeOnly(`export * from "./a";\nexport { b } from "./b";`), true);
  assert.equal(isBarrelOrTypeOnly(`export interface Foo { id: string }\nexport type Bar = number;`), true);
  assert.equal(isBarrelOrTypeOnly(`export function handle() { return 1; }`), false);
  assert.equal(isBarrelOrTypeOnly(`export class Server { start() {} }`), false);
});

test("repoFileInventory lists real source files grouped by extension", () => {
  withRepo(
    {
      "src/main.rs": "fn main() {}",
      "src/kv_cache.rs": "pub fn alloc() {}",
      "app/loader.swift": "func load() {}",
      "README.md": "# repo",
      "assets/logo.png": "binary",
    },
    (tools) => {
      const inventory = repoFileInventory(tools);
      assert.match(inventory, /Source file inventory/);
      // Real source files appear verbatim...
      assert.match(inventory, /src\/main\.rs/);
      assert.match(inventory, /src\/kv_cache\.rs/);
      assert.match(inventory, /app\/loader\.swift/);
      // ...grouped by extension with counts.
      assert.match(inventory, /\.rs \(2 files\)/);
      assert.match(inventory, /\.swift \(1 file\)/);
      // Non-source files are not listed as code.
      assert.ok(!/logo\.png/.test(inventory), "non-source assets should be excluded");
    }
  );
});

test("repoFileInventory returns empty string for a repo with no source files", () => {
  withRepo({ "README.md": "# docs", "data.json": "{}" }, (tools) => {
    assert.equal(repoFileInventory(tools), "");
  });
});

test("repoFileInventory excludes build/dependency directories across ecosystems", () => {
  withRepo(
    {
      "src/main.rs": "fn main() {}",
      // Rust build output — must not flood the inventory.
      "target/debug/deps/dep1.rs": "pub fn dep1() {}",
      "target/debug/deps/dep2.rs": "pub fn dep2() {}",
      // Go vendored dependency source.
      "vendor/github.com/foo/foo.go": "package foo",
      // Python virtual env.
      ".venv/lib/site.py": "x = 1",
    },
    (tools) => {
      const inventory = repoFileInventory(tools);
      assert.match(inventory, /src\/main\.rs/);
      assert.match(inventory, /\.rs \(1 file\)/, "only the real source .rs should remain");
      assert.ok(!/target\//.test(inventory), "Rust target/ must be excluded");
      assert.ok(!/vendor\//.test(inventory), "Go vendor/ must be excluded");
      assert.ok(!/\.venv\//.test(inventory), "Python .venv/ must be excluded");
    }
  );
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

test("rankHubs ranks a Python module by its importers", () => {
  withRepo(
    {
      "pkg/core.py": "def run():\n    return 1\n",
      "pkg/a.py": "from .core import run\nrun()\n",
      "pkg/b.py": "from pkg.core import run\nrun()\n",
      "pkg/c.py": "import core\ncore.run()\n",
    },
    (tools) => {
      const hubs = rankHubs(tools, tools.findByName("*"));
      const core = hubs.find((h) => h.file === "pkg/core.py");
      assert.ok(core, "core.py should be ranked as a hub");
      assert.equal(core!.importers, 3);
    }
  );
});

test("rankHubs excludes a re-export __init__.py (Python barrel)", () => {
  withRepo(
    {
      "pkg/__init__.py": "from .service import Service\nfrom .model import Model\nfrom .util import helper\n",
      "pkg/service.py": "class Service:\n    def handle(self):\n        return 1\n",
      "pkg/a.py": "from pkg import Service\n",
      "pkg/b.py": "from pkg import Service\n",
    },
    (tools) => {
      const hubs = rankHubs(tools, tools.findByName("*"));
      assert.ok(!hubs.some((h) => h.file === "pkg/__init__.py"), "__init__ barrel must be excluded");
    }
  );
});

test("rankHubs ranks a Rust module and excludes a pub-use mod.rs", () => {
  withRepo(
    {
      "src/engine/mod.rs": "pub use self::runner::Runner;\npub mod runner;\n",
      "src/engine/runner.rs": "pub struct Runner;\nimpl Runner {\n    pub fn run(&self) -> u32 { 1 }\n}\n",
      "src/a.rs": "use crate::engine::runner::Runner;\nfn go() { Runner.run(); }\n",
      "src/b.rs": "use crate::engine::runner::Runner;\nfn go2() { Runner.run(); }\n",
    },
    (tools) => {
      const hubs = rankHubs(tools, tools.findByName("*"));
      assert.ok(!hubs.some((h) => h.file === "src/engine/mod.rs"), "pub-use mod.rs must be excluded");
      const runner = hubs.find((h) => h.file === "src/engine/runner.rs");
      assert.ok(runner, "runner.rs should be ranked");
      assert.ok(runner!.importers >= 2, "runner imported by a.rs and b.rs");
    }
  );
});
