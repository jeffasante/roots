import type { ModelMeta } from "../types.js";
import type { BackendConfig, ChatRequest, ChatResponse, InferenceBackend } from "./types.js";

/**
 * cellm backend — talks to Jeff's own Rust inference engine running as a
 * local sidecar. The sidecar is expected to expose an OpenAI-compatible
 * `/chat/completions` endpoint (default http://localhost:8080/v1), which keeps
 * this TS engine decoupled from the Rust ABI. When roots' engine is later
 * ported to Rust, this becomes a direct crate dependency instead.
 *
 * This is the differentiating backend: same repo, same query, local model —
 * compared against cloud backends by the eval harness.
 */
export class CellmBackend implements InferenceBackend {
  readonly meta: ModelMeta;
  private readonly baseUrl: string;

  constructor(private readonly cfg: BackendConfig) {
    this.baseUrl = (cfg.baseUrl ?? "http://localhost:8080/v1").replace(/\/$/, "");
    this.meta = { backend: "cellm", model_name: cfg.model, mode: "local" };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: req.messages,
        temperature: req.temperature ?? this.cfg.temperature ?? 0,
        max_tokens: req.maxTokens ?? this.cfg.maxTokens ?? 4096,
        // Small local models often need schema-constrained decoding to produce
        // valid codemap JSON; the sidecar honors this hint when supported.
        response_format: req.jsonMode ? { type: "json_object" } : undefined,
      }),
    });

    if (!res.ok) {
      throw new Error(`cellm sidecar error ${res.status}: ${await safeText(res)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      content: data.choices?.[0]?.message?.content ?? "",
      usage: { promptTokens: data.usage?.prompt_tokens, completionTokens: data.usage?.completion_tokens },
    };
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
