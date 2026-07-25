import { redactSecrets } from "./secrets.js";
import type { ModelMeta } from "../types.js";
import type { BackendConfig, ChatRequest, ChatResponse, InferenceBackend } from "./types.js";

/** Anthropic Messages API backend. */
export class AnthropicBackend implements InferenceBackend {
  readonly meta: ModelMeta;
  private readonly baseUrl: string;

  constructor(private readonly cfg: BackendConfig) {
    if (!cfg.apiKey) throw new Error("Anthropic backend requires an API key.");
    this.baseUrl = cfg.baseUrl ?? "https://api.anthropic.com";
    this.meta = { backend: "anthropic", model_name: cfg.model, mode: "cloud" };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const system = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role, content: m.content }));

    const res = await fetch(`${this.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.cfg.apiKey!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.cfg.model,
        system: system || undefined,
        messages,
        max_tokens: req.maxTokens ?? this.cfg.maxTokens ?? 4096,
        temperature: req.temperature ?? this.cfg.temperature ?? 0,
      }),
    });

    if (!res.ok) {
      throw new Error(`Anthropic API error ${res.status}: ${redactSecrets(await safeText(res), this.cfg.apiKey)}`);
    }
    const data = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const content = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    return {
      content,
      usage: { promptTokens: data.usage?.input_tokens, completionTokens: data.usage?.output_tokens },
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
