/**
 * Secret handling helpers shared by cloud backends.
 *
 * Two goals:
 *  1. Let the API key be supplied via an environment variable so it never has
 *     to cross the JSON-RPC/stdio boundary as a request parameter.
 *  2. Scrub anything that looks like a key from provider error text before it
 *     is surfaced to the UI or logs.
 */

import type { BackendConfig } from "./types.js";

/**
 * Provider-specific environment variables checked when no key is passed.
 * The `openai` kind is OpenAI-compatible and covers NVIDIA NIM and Groq, so it
 * also honours those providers' conventional env var names.
 */
const ENV_KEYS: Record<string, string[]> = {
  anthropic: ["ROOTS_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"],
  openai: ["ROOTS_OPENAI_API_KEY", "OPENAI_API_KEY", "NVIDIA_API_KEY", "NVIDIA_NIM_API_KEY", "GROQ_API_KEY"],
};

/**
 * Resolve the API key for a backend config, preferring an explicit value and
 * falling back to provider environment variables. Returns undefined if none.
 */
export function resolveApiKey(cfg: Pick<BackendConfig, "kind" | "apiKey">): string | undefined {
  if (cfg.apiKey) return cfg.apiKey;
  const candidates = ENV_KEYS[cfg.kind] ?? [];
  for (const name of candidates) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

/**
 * Remove secret-looking tokens from text so keys never leak through error
 * messages. Redacts bearer tokens, common provider key prefixes, and any
 * explicitly known key value.
 */
export function redactSecrets(text: string, known?: string): string {
  let out = text;
  if (known) {
    out = out.split(known).join("[redacted]");
  }
  return out
    // Authorization: Bearer <token>
    .replace(/(bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted]")
    // x-api-key style header echoes
    .replace(/(x-api-key["'\s:=]+)[A-Za-z0-9._\-]+/gi, "$1[redacted]")
    // Common provider key prefixes (OpenAI sk-, Anthropic sk-ant-, NVIDIA nvapi-)
    .replace(/\b(sk-ant-|sk-|nvapi-)[A-Za-z0-9._\-]{8,}/g, "[redacted]");
}
