/**
 * Minimal newline-delimited JSON-RPC 2.0 over a duplex stream (stdin/stdout).
 * Kept dependency-free and small — the adapter talks to the engine over this.
 */

import type { Readable, Writable } from "node:stream";

export interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface RpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RpcHandler = (params: unknown, notify: (method: string, params: unknown) => void) => Promise<unknown>;

export class RpcServer {
  private readonly handlers = new Map<string, RpcHandler>();
  private buffer = "";

  constructor(private readonly input: Readable, private readonly output: Writable) {}

  on(method: string, handler: RpcHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  listen(): void {
    this.input.setEncoding("utf8");
    this.input.on("data", (chunk: string) => this.onData(chunk));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (line) void this.handleLine(line);
    }
  }

  private async handleLine(line: string): Promise<void> {
    let req: RpcRequest;
    try {
      req = JSON.parse(line);
    } catch {
      this.send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    const id = req.id ?? null;
    const handler = this.handlers.get(req.method);
    if (!handler) {
      this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${req.method}` } });
      return;
    }

    const notify = (method: string, params: unknown) =>
      this.send({ jsonrpc: "2.0", id: null, method, params } as unknown as RpcResponse);

    try {
      const result = await handler(req.params, notify);
      this.send({ jsonrpc: "2.0", id, result });
    } catch (err) {
      this.send({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  private send(msg: RpcResponse | (RpcResponse & { method: string; params: unknown })): void {
    this.output.write(JSON.stringify(msg) + "\n");
  }
}
