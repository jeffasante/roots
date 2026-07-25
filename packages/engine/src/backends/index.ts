import { AnthropicBackend } from "./anthropic.js";
import { CellmBackend } from "./cellm.js";
import { OllamaBackend } from "./ollama.js";
import { OpenAICompatibleBackend } from "./openai.js";
import { resolveApiKey } from "./secrets.js";
import type { BackendConfig, BackendKind, InferenceBackend } from "./types.js";

export * from "./types.js";
export { AnthropicBackend, CellmBackend, OllamaBackend, OpenAICompatibleBackend };

/** A selectable backend option surfaced in the VS Code picker. */
export interface BackendOption {
  kind: BackendKind;
  label: string;
  description: string;
  mode: "cloud" | "local";
  /** Whether this option needs an API key from the user. */
  requiresApiKey: boolean;
  /** Suggested default model for quick-start. */
  defaultModel: string;
  /** Optional curated list of models to offer in the picker (with a Custom… escape hatch). */
  models?: { id: string; label: string; note?: string }[];
  /** Optional preset base URL for OpenAI-compatible providers. */
  baseUrl?: string;
}

/**
 * The catalog of backend options the UI lists. Users bring their own keys.
 * Presets cover the "some even from cellm / NVIDIA's free AI" requirement:
 * a couple of OpenAI-compatible providers plus the two local runtimes.
 */
export const BACKEND_OPTIONS: BackendOption[] = [
  {
    kind: "anthropic",
    label: "Anthropic (Claude)",
    description: "Cloud · bring your Anthropic API key",
    mode: "cloud",
    requiresApiKey: true,
    defaultModel: "claude-sonnet-4-20250514",
  },
  {
    kind: "openai",
    label: "OpenAI",
    description: "Cloud · OpenAI API key",
    mode: "cloud",
    requiresApiKey: true,
    defaultModel: "gpt-4o-mini",
    baseUrl: "https://api.openai.com/v1",
  },
  {
    kind: "openai",
    label: "NVIDIA NIM (free tier)",
    description: "Cloud · OpenAI-compatible · NVIDIA API key",
    mode: "cloud",
    requiresApiKey: true,
    defaultModel: "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    // Curated text LLMs from build.nvidia.com that suit codemap research + synthesis.
    // Reasoning/coding-strong models first; smaller/faster options after.
    models: [
      { id: "nvidia/llama-3.3-nemotron-super-49b-v1.5", label: "Nemotron Super 49B v1.5", note: "reasoning · tool calling · recommended" },
      { id: "nvidia/nemotron-3-super-120b-a12b", label: "Nemotron 3 Super 120B", note: "agentic · 1M context" },
      { id: "deepseek-ai/deepseek-v4-flash", label: "DeepSeek V4 Flash", note: "fast coding + agents" },
      { id: "moonshotai/kimi-k2.6", label: "Kimi K2.6", note: "long-horizon coding" },
      { id: "zai/glm-5.2", label: "GLM-5.2", note: "agentic + coding" },
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", note: "MoE reasoning" },
      { id: "qwen/qwen3-coder-480b-a35b-instruct", label: "Qwen3 Coder 480B", note: "code-specialized" },
      { id: "meta/llama-4-maverick-17b-128e-instruct", label: "Llama 4 Maverick 17B", note: "multimodal MoE" },
      { id: "meta/llama-3.3-70b-instruct", label: "Llama 3.3 70B", note: "reasoning · function calling" },
      { id: "meta/llama-3.1-70b-instruct", label: "Llama 3.1 70B", note: "general" },
      { id: "meta/llama-3.1-8b-instruct", label: "Llama 3.1 8B", note: "fast · lightweight" },
    ],
  },
  {
    kind: "openai",
    label: "Groq",
    description: "Cloud · OpenAI-compatible · Groq API key",
    mode: "cloud",
    requiresApiKey: true,
    defaultModel: "llama-3.3-70b-versatile",
    baseUrl: "https://api.groq.com/openai/v1",
  },
  {
    kind: "ollama",
    label: "Ollama (local)",
    description: "Local · no key · needs Ollama running",
    mode: "local",
    requiresApiKey: false,
    defaultModel: "qwen2.5:7b",
    baseUrl: "http://localhost:11434",
  },
  {
    kind: "cellm",
    label: "cellm (local)",
    description: "Local · cellm sidecar · the differentiator",
    mode: "local",
    requiresApiKey: false,
    defaultModel: "qwen2.5-0.5b",
    baseUrl: "http://localhost:8080/v1",
  },
];

export function createBackend(cfg: BackendConfig): InferenceBackend {
  // Resolve the key from an env var when it wasn't supplied over RPC, so the
  // secret can stay out of request params entirely.
  const resolved: BackendConfig = { ...cfg, apiKey: resolveApiKey(cfg) };
  switch (resolved.kind) {
    case "anthropic":
      return new AnthropicBackend(resolved);
    case "openai":
      return new OpenAICompatibleBackend(resolved);
    case "ollama":
      return new OllamaBackend(resolved);
    case "cellm":
      return new CellmBackend(resolved);
    default: {
      const _exhaustive: never = resolved.kind;
      throw new Error(`Unknown backend kind: ${String(_exhaustive)}`);
    }
  }
}
