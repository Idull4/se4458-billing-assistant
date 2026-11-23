// LLM client: OpenAI-compatible Chat Completions API with function (tool) calling.
// Works with Google Gemini (default, free tier) through its OpenAI-compatible endpoint, or with OpenAI.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  [extra: string]: unknown; // e.g. Gemini thought signatures (extra_content) - must be sent back unchanged
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; [extra: string]: unknown }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolDefinition {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface LlmConfig {
  provider: "gemini" | "openai";
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface Llm {
  readonly model: string;
  chat(messages: ChatMessage[], tools: ToolDefinition[]): Promise<Extract<ChatMessage, { role: "assistant" }>>;
}

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
// Flash-Lite: tool calling + a much larger free daily quota than gemini-3.6-flash (20 requests/day on the free tier).
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";
export const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";

/** Pick provider from environment: GEMINI_API_KEY (default) or OPENAI_API_KEY. */
export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const provider = (env.LLM_PROVIDER ?? (env.GEMINI_API_KEY ? "gemini" : "openai")).toLowerCase();
  if (provider === "gemini") {
    if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set (get one at https://aistudio.google.com and add it to .env).");
    return { provider: "gemini", apiKey: env.GEMINI_API_KEY, baseUrl: env.LLM_BASE_URL ?? GEMINI_BASE_URL, model: env.LLM_MODEL ?? DEFAULT_GEMINI_MODEL };
  }
  const key = env.OPENAI_API_KEY;
  if (!key || key === "sk-...") throw new Error("No LLM key: set GEMINI_API_KEY (free) or OPENAI_API_KEY in .env.");
  return { provider: "openai", apiKey: key, baseUrl: env.LLM_BASE_URL ?? "https://api.openai.com/v1/", model: env.LLM_MODEL ?? DEFAULT_OPENAI_MODEL };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export function createLlm(config: LlmConfig, fetchImpl: FetchLike = fetch, retryDelaysMs = [10000, 30000, 60000]): Llm {
  const url = config.baseUrl.replace(/\/?$/, "/") + "chat/completions";
  return {
    model: config.model,
    async chat(messages, tools) {
      const body = JSON.stringify({ model: config.model, messages, tools, tool_choice: "auto" });
      for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
          body,
        });
        if (res.ok) {
          const data = await res.json() as any;
          const message = data?.choices?.[0]?.message;
          if (!message) throw new Error(`LLM returned no message: ${JSON.stringify(data).slice(0, 300)}`);
          return { ...message, role: "assistant", content: message.content ?? null };
        }
        const text = await res.text();
        // A daily quota does not recover by waiting: fail fast with a hint instead of retrying.
        if (res.status === 429 && /per day|PerDay|requests_per_day/i.test(text)) {
          throw new Error(`Daily free-tier quota of model "${config.model}" is used up. Set another model in .env, e.g. LLM_MODEL=gemini-3.1-flash-lite, or try again after the quota resets (midnight US Pacific time).`);
        }
        // Per-minute rate limits: wait and retry on 429 / 503.
        if ((res.status === 429 || res.status === 503) && attempt < retryDelaysMs.length) {
          const retryAfter = Number(res.headers.get("retry-after"));
          const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : retryDelaysMs[attempt];
          console.error(`[LLM] ${res.status} (rate limit/busy) - retrying in ${Math.round(wait / 1000)}s...`);
          await sleep(wait);
          continue;
        }
        throw new Error(`LLM request failed (${res.status}): ${text.slice(0, 500)}`);
      }
    },
  };
}
