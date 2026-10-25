import type { Env } from "../env";

// Provider-agnostic client for OpenAI-compatible chat completions with tool
// calling. Groq and OpenRouter both speak this format, so switching provider
// or model is a config change (plan N6, D13).

const PROVIDER_URLS: Record<string, string> = {
  groq: "https://api.groq.com/openai/v1",
  openrouter: "https://openrouter.ai/api/v1",
};

export interface LlmConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export class LlmError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "LlmError";
  }
}

export function llmConfig(env: Env): LlmConfig {
  const provider = (env.LLM_PROVIDER || "groq").toLowerCase();
  const baseUrl = env.LLM_BASE_URL || PROVIDER_URLS[provider];
  if (!baseUrl) throw new LlmError(`unknown LLM_PROVIDER '${provider}' and no LLM_BASE_URL set`);
  if (!env.LLM_API_KEY) throw new LlmError("LLM_API_KEY is not set (put it in .dev.vars locally, or `wrangler secret put LLM_API_KEY`)");
  return { provider, baseUrl: baseUrl.replace(/\/+$/, ""), model: env.LLM_MODEL || "openai/gpt-oss-120b", apiKey: env.LLM_API_KEY };
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  calls: number;
}

export interface CompletionOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  /** Accumulates token counts reported by the provider (for evals and cost estimates). */
  usage?: Usage;
}

export async function complete(
  cfg: LlmConfig,
  messages: ChatMessage[],
  tools: ToolSpec[],
  opts: CompletionOptions = {},
): Promise<{ content: string | null; tool_calls: ToolCall[] }> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = JSON.stringify({
    model: cfg.model,
    messages,
    tools: tools.map((t) => ({ type: "function", function: t })),
    tool_choice: "auto",
    temperature: 0,
  });

  // One retry on 5xx or network failure; 429 is reported, not retried, to protect the free quota.
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await doFetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
        body,
        signal: opts.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw new LlmError("LLM request timed out");
      if (attempt === 0) continue;
      throw new LlmError(`LLM request failed: ${(e as Error).message}`);
    }
    if (res.status >= 500 && attempt === 0) continue;
    if (!res.ok) {
      const text = (await res.text()).slice(0, 500);
      throw new LlmError(
        res.status === 429 ? "LLM rate limit reached; try again in a minute" : `LLM error ${res.status}: ${text}`,
        res.status,
      );
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (opts.usage) {
      opts.usage.calls += 1;
      opts.usage.prompt_tokens += json.usage?.prompt_tokens ?? 0;
      opts.usage.completion_tokens += json.usage?.completion_tokens ?? 0;
    }
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new LlmError("LLM response had no message");
    return { content: msg.content ?? null, tool_calls: msg.tool_calls ?? [] };
  }
}
