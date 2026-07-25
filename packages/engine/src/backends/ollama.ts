import type { ModelMeta } from "../types.js";
import type { BackendConfig, ChatRequest, ChatResponse, InferenceBackend } from "./types.js";

/** Local Ollama backend (HTTP on localhost:11434 by default). */
export class OllamaBackend implements InferenceBackend {
  readonly meta: ModelMeta;
  private readonly baseUrl: string;

  constructor(private readonly cfg: BackendConfig) {
    this.baseUrl = (cfg.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    this.meta = { backend: "ollama", model_name: cfg.model, mode: "local" };
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.cfg.model,
        messages: req.messages,
        stream: false,
        format: req.jsonMode ? "json" : undefined,
        options: { temperature: req.temperature ?? this.cfg.temperature ?? 0 },
      }),
    });

    if (!res.ok) {
      throw new Error(`Ollama API error ${res.status}: ${await safeText(res)}`);
    }
    const data = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      content: data.message?.content ?? "",
      usage: { promptTokens: data.prompt_eval_count, completionTokens: data.eval_count },
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
