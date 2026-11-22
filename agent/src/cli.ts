// Command-line chat for the AI Billing Support Assistant.
//   GEMINI_API_KEY (free, default) or OPENAI_API_KEY; LLM_MODEL to override the model
//   GATEWAY_URL  API Gateway base URL - all REST calls go through it (default http://localhost:8000)
//   MCP_URL      Streamable HTTP MCP endpoint; if unset the MCP server is started locally over stdio
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatTrace, runTurn } from "./agent.ts";
import { loadEnv } from "./env.ts";
import { GatewayClient } from "./gateway-client.ts";
import { createLlm, resolveLlmConfig, type ChatMessage } from "./llm.ts";
import { connectMcp } from "./mcp-client.ts";
import { createToolExecutor, type Session } from "./tools.ts";

loadEnv();
const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:8000";
const logDir = fileURLToPath(new URL("../../docs/logs/", import.meta.url));
/** Remove ANSI escape sequences (e.g. bracketed paste markers) and control characters from typed input. */
export const clean = (line: string) =>
  line.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, "").replace(/\[20[01]~/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim();
const arg = (name: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

async function main() {
  const llmConfig = resolveLlmConfig();
  const llm = createLlm(llmConfig);
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY ?? false });
  // Line queue: works for interactive use and for piped input (e.g. scripted demos).
  const lines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;
  rl.on("line", line => { const w = waiters.shift(); if (w) w(line); else lines.push(line); });
  rl.on("close", () => { closed = true; while (waiters.length) waiters.shift()!(null); });
  const ask = (prompt: string) => {
    stdout.write(prompt);
    if (lines.length) return Promise.resolve<string | null>(lines.shift()!);
    if (closed) return Promise.resolve<string | null>(null);
    return new Promise<string | null>(resolve => waiters.push(resolve));
  };
  const client = new GatewayClient(gatewayUrl);

  // ---- login through the gateway (JWT) ----
  const user = arg("user") ?? ((await ask("Subscriber number: ")) ?? "").trim();
  const password = arg("password") ?? ((await ask("Password: ")) ?? "").trim();
  const login = await client.login(user, password);
  if (!login.ok) throw new Error(`Login failed (${login.status}): ${JSON.stringify(login.body)}`);
  if (login.body.role !== "subscriber") throw new Error("Please log in as a subscriber (the assistant has no admin tools).");
  const session: Session = { subscriberNo: login.body.subscriberNo, token: login.body.accessToken };

  // ---- MCP client ----
  const docs = await connectMcp(process.env.MCP_URL || undefined);
  const execute = createToolExecutor(session, client, docs);

  mkdirSync(logDir, { recursive: true });
  const logFile = `${logDir}session-${new Date().toISOString().replace(/[:.]/g, "-")}.log`;
  const log = (text: string) => appendFileSync(logFile, text + "\n");
  const header = `LLM: ${llmConfig.provider} ${llm.model} | Gateway: ${gatewayUrl} | MCP: ${docs.description} | Subscriber: ${session.subscriberNo}`;
  log(`# Session ${new Date().toISOString()} | ${header}`);
  console.log(`\nLogged in. ${header}`);
  console.log('Ask about your bill, e.g. "Why is my October bill higher than September?". Type "exit" to quit.\n');

  const confirm = async (summary: string) => {
    const answer = clean((await ask(`\n[CONFIRMATION REQUIRED] ${summary} Type "yes" to confirm: `)) ?? "").toLowerCase();
    if (!stdout.isTTY) console.log(answer);
    return answer === "yes" || answer === "evet";
  };

  let history: ChatMessage[] = [];
  try {
    for (;;) {
      const line = await ask("you> ");
      if (line === null) break;
      const question = clean(line);
      if (!/[\p{L}\p{N}]/u.test(question)) continue; // ignore empty lines and stray control characters (e.g. from pasting)
      if (!stdout.isTTY) console.log(question); // echo only when output goes to a file/pipe
      if (/^(exit|quit)$/i.test(question)) break;
      try {
        const turn = await runTurn({ llm, execute, confirm, session }, history, question);
        history = turn.history;
        console.log(`\nassistant> ${turn.answer}\n`);
        if (process.env.SHOW_TRACE !== "false") console.log(formatTrace(turn.trace, turn.answer) + "\n");
        log(`\nuser: ${question}\n${formatTrace(turn.trace, turn.answer, 4000)}`);
      } catch (error) {
        console.error("Request failed:", error instanceof Error ? error.message : error);
      }
    }
  } finally {
    rl.close();
    await docs.close();
    console.log(`Trace log saved to ${logFile}`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
