// Connectivity check for the configured LLM: lists available models and runs one tool-calling request.
//   npm run check-llm
import { loadEnv } from "./env.ts";
import { createLlm, resolveLlmConfig } from "./llm.ts";

loadEnv();

async function main() {
  const config = resolveLlmConfig();
  console.log(`Provider: ${config.provider} | Base URL: ${config.baseUrl} | Model: ${config.model}`);

  const res = await fetch(config.baseUrl.replace(/\/?$/, "/") + "models", { headers: { authorization: `Bearer ${config.apiKey}` } });
  if (!res.ok) {
    console.error(`Listing models failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const ids: string[] = ((await res.json() as any).data ?? []).map((m: any) => String(m.id).replace(/^models\//, ""));
  const flash = ids.filter(id => /flash|mini/.test(id));
  console.log(`Key OK. ${ids.length} models available. Candidates: ${(flash.length ? flash : ids).slice(0, 15).join(", ")}`);
  if (!ids.includes(config.model)) {
    console.warn(`WARNING: model "${config.model}" is not in the list. Set LLM_MODEL in .env to one of the candidates above.`);
  }

  const llm = createLlm(config);
  const reply = await llm.chat(
    [{ role: "user", content: "What is the weather in Izmir? Use the tool." }],
    [{ type: "function", function: { name: "get_weather", description: "Get weather for a city", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }],
  );
  const call = reply.tool_calls?.[0];
  if (call) console.log(`Tool calling OK: model requested ${call.function.name}(${call.function.arguments})`);
  else console.warn(`Model answered without a tool call: ${reply.content}`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
