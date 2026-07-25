import { redactSecrets } from "./secrets.js";
import type { ModelMeta } from "../types.js";
import type { BackendConfig, ChatRequest, ChatResponse, InferenceBackend } from "./types.js";

/**
 * OpenAI-compatible chat-completions backend.
 *
 * Works with OpenAI, Groq, NVIDIA (https://integrate.api.nvidia.com/v1),
 * and any gateway exposing the same schema — pick the provider by setting
 * `baseUrl` and `apiKey`. This is the "bring your own key" path.
 */
export class OpenAICompatibleBackend implements InferenceBackend {
  readonly meta: ModelMeta;
  private readonly baseUrl: string;

  constructor(private readonly cfg: BackendConfig) {
    if (!cfg.apiKey) throw new Error("OpenAI-compatible backend requires an API key.");
    this.baseUrl = (cfg.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.meta = { backend: "openai", model_name: cfg.model, mode: "cloud" };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: req.messages,
        temperature: req.temperature ?? this.cfg.temperature ?? 0,
        max_tokens: req.maxTokens ?? this.cfg.maxTokens ?? 4096,
        response_format: req.jsonMode ? { type: "json_object" } : undefined,
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenAI-compatible API error ${res.status}: ${redactSecrets(await safeText(res), this.cfg.apiKey)}`);
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
