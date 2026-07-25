/**
 * Pluggable inference backend interface.
 *
 * All backends — cloud (Anthropic, OpenAI-compatible incl. NVIDIA/Groq),
 * local (Ollama), or embedded (cellm) — implement one interface so swapping
 * is a config change, not a rewrite. Every codemap self-reports which backend
 * produced it (see ModelMeta) so results are comparable across backends.
 */

import type { ModelMeta } from "../types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Nudge toward valid JSON output where the backend supports it. */
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  content: string;
  /** Optional token accounting, when the backend reports it. */
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface InferenceBackend {
  readonly meta: ModelMeta;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/** Backend identifiers surfaced in the UI picker. */
export type BackendKind = "anthropic" | "openai" | "ollama" | "cellm";

export interface BackendConfig {
  kind: BackendKind;
  /** Concrete model name (e.g. 'claude-sonnet-4-20250514', 'qwen2.5:0.5b'). */
  model: string;
  /** API key for cloud backends. Never logged. */
  apiKey?: string;
  /**
   * Base URL override. Enables OpenAI-compatible endpoints such as NVIDIA
   * (https://integrate.api.nvidia.com/v1), Groq, or a self-hosted gateway.
   */
  baseUrl?: string;
  temperature?: number;
  maxTokens?: number;
}
