#!/usr/bin/env node
/**
 * roots-engine stdio server.
 *
 * Speaks newline-delimited JSON-RPC 2.0 on stdin/stdout. The VS Code adapter
 * spawns this process and calls its methods. Keeping the engine out-of-process
 * isolates the "read your code" trust boundary and CPU-heavy work from the
 * extension host.
 *
 * Methods:
 *   listBackends()                              -> BackendOption[]
 *   generateCodemap({ query, repoRoot, backend }) -> Codemap   (notifies "progress")
 *   listCodemaps({ repoRoot })                  -> Codemap[]
 *   getCodemap({ repoRoot, id })                -> Codemap
 *   deleteCodemap({ repoRoot, id })             -> { ok: true }
 *   validateCodemap({ codemap })                -> ValidationResult
 *   askCodemap({ codemap, question, backend })  -> { answer, citations }
 */

import { Agent } from "./agent.js";
import { askCodemap } from "./ask.js";
import { BACKEND_OPTIONS, createBackend, type BackendConfig } from "./backends/index.js";
import { RpcServer } from "./rpc.js";
import { CodemapStore } from "./store.js";
import { suggestCodemaps, type SuggestionIntensity } from "./suggestions.js";
import { validateCodemap } from "./validate.js";
import type { Codemap } from "./types.js";

const server = new RpcServer(process.stdin, process.stdout);

server.on("listBackends", async () => BACKEND_OPTIONS);

server.on("suggestCodemaps", async (params) => {
  const p = params as { repoRoot: string; backend: BackendConfig; intensity?: SuggestionIntensity };
  if (!p?.repoRoot || !p?.backend) {
    throw new Error("suggestCodemaps requires { repoRoot, backend }");
  }
  return suggestCodemaps(createBackend(p.backend), p.repoRoot, p.intensity);
});

server.on("generateCodemap", async (params, notify) => {
  const p = params as { query: string; repoRoot: string; backend: BackendConfig };
  if (!p?.query || !p?.repoRoot || !p?.backend) {
    throw new Error("generateCodemap requires { query, repoRoot, backend }");
  }

  const backend = createBackend(p.backend);
  const agent = new Agent(backend);
  const store = new CodemapStore(p.repoRoot);

  const codemap = await agent.run({
    query: p.query,
    repoRoot: p.repoRoot,
    onProgress: (evt) => notify("progress", evt),
  });
  codemap.repo.commit = store.currentCommit();

  const savedPath = store.save(codemap);
  return { codemap, savedPath };
});

server.on("listCodemaps", async (params) => {
  const p = params as { repoRoot: string };
  return new CodemapStore(p.repoRoot).list();
});

server.on("getCodemap", async (params) => {
  const p = params as { repoRoot: string; id: string };
  return new CodemapStore(p.repoRoot).load(p.id);
});

server.on("deleteCodemap", async (params) => {
  const p = params as { repoRoot: string; id: string };
  new CodemapStore(p.repoRoot).delete(p.id);
  return { ok: true };
});

server.on("validateCodemap", async (params) => {
  const p = params as { codemap: unknown };
  return validateCodemap(p.codemap);
});

server.on("askCodemap", async (params) => {
  const p = params as { codemap: Codemap; question: string; backend: BackendConfig };
  if (!p?.codemap || !p?.question || !p?.backend) {
    throw new Error("askCodemap requires { codemap, question, backend }");
  }
  return askCodemap(createBackend(p.backend), p.codemap, p.question);
});

server.listen();

// Keep the process alive; stdio streams handle lifecycle.
process.stdin.resume();
