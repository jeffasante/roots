import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as path from "node:path";

/** Mirror of engine-side types the adapter needs (kept minimal, no runtime import). */
export interface BackendOption {
  kind: "anthropic" | "openai" | "ollama" | "cellm";
  label: string;
  description: string;
  mode: "cloud" | "local";
  requiresApiKey: boolean;
  defaultModel: string;
  models?: { id: string; label: string; note?: string }[];
  baseUrl?: string;
}

export interface BackendConfig {
  kind: BackendOption["kind"];
  model: string;
  apiKey?: string;
  baseUrl?: string;
}

export interface Location {
  file: string;
  start_line: number;
  end_line: number;
}
export interface Confidence {
  location_verified: boolean;
  location_evidence: "symbol" | "file_line" | "none";
  summary_grounded?: number;
}
export interface Trace {
  id: string;
  title: string;
  summary: string;
  motivation?: string;
  details?: string;
  locations: Location[];
  children?: string[];
  confidence?: Confidence;
  focus?: boolean;
}
export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  condition?: string;
}
export interface Codemap {
  version: string;
  id: string;
  query: string;
  overview?: string;
  created_at: string;
  model: { backend: string; model_name: string; mode: "cloud" | "local" };
  repo: { root: string; commit?: string };
  traces: Trace[];
  diagram?: { format: "mermaid"; content: string };
  edges?: DiagramEdge[];
}

export interface ProgressEvent {
  phase: "research" | "synthesis";
  message: string;
  step?: number;
  action?: string;
  file?: string;
  detail?: string;
}

export interface CodemapSuggestion {
  title: string;
  description: string;
  query: string;
}

/** Difficulty tier for repository suggestions. */
export type SuggestionIntensity = "foundational" | "intermediate" | "advanced";

export interface AskResult {
  answer: string;
  citations: Location[];
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * Spawns roots-engine and talks to it over newline-delimited JSON-RPC on stdio.
 * One long-lived process per workspace session.
 */
export class EngineClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private progressHandler: ((e: ProgressEvent) => void) | null = null;

  constructor(private readonly enginePath: string) {}

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.proc && !this.proc.killed) return this.proc;

    const proc = spawn(process.execPath, [this.enginePath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => console.error("[roots-engine]", chunk));
    proc.on("exit", (code) => {
      for (const [, p] of this.pending) p.reject(new Error(`Engine exited (code ${code})`));
      this.pending.clear();
      this.proc = null;
    });
    this.proc = proc;
    return proc;
  }

  onProgress(handler: (e: ProgressEvent) => void): void {
    this.progressHandler = handler;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.handleMessage(line);
    }
  }

  private handleMessage(line: string): void {
    let msg: {
      id?: number | null;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: unknown;
    };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    // Server-initiated notification (progress).
    if (msg.method === "progress") {
      this.progressHandler?.(msg.params as ProgressEvent);
      return;
    }

    if (typeof msg.id === "number") {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    }
  }

  private call<T>(method: string, params: unknown): Promise<T> {
    const proc = this.ensureStarted();
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  listBackends(): Promise<BackendOption[]> {
    return this.call("listBackends", {});
  }

  suggestCodemaps(args: {
    repoRoot: string;
    backend: BackendConfig;
    intensity?: SuggestionIntensity;
  }): Promise<CodemapSuggestion[]> {
    return this.call("suggestCodemaps", args);
  }

  generateCodemap(args: { query: string; repoRoot: string; backend: BackendConfig }): Promise<{ codemap: Codemap; savedPath: string }> {
    return this.call("generateCodemap", args);
  }

  listCodemaps(repoRoot: string): Promise<Codemap[]> {
    return this.call("listCodemaps", { repoRoot });
  }

  getCodemap(repoRoot: string, id: string): Promise<Codemap> {
    return this.call("getCodemap", { repoRoot, id });
  }

  deleteCodemap(repoRoot: string, id: string): Promise<{ ok: true }> {
    return this.call("deleteCodemap", { repoRoot, id });
  }

  askCodemap(args: { codemap: Codemap; question: string; backend: BackendConfig }): Promise<AskResult> {
    return this.call("askCodemap", args);
  }

  dispose(): void {
    this.proc?.kill();
    this.proc = null;
  }
}

/** Resolve the engine entry: explicit setting, else the engine bundled in the VSIX. */
export function resolveEnginePath(explicit: string, extensionRoot: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim();
  return path.resolve(extensionRoot, "engine", "dist", "server.js");
}
