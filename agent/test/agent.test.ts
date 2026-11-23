// Agent tests without a live LLM: a scripted fake LLM drives the real agent loop, tools run against a
// fake HTTP gateway and a fake MCP search. Covers tool selection flow, confirmation, identity and the LLM client.
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { formatTrace, instructions, runTurn, type AgentDeps } from "../src/agent.ts";
import { GatewayClient, type FetchLike } from "../src/gateway-client.ts";
import { createLlm, GEMINI_BASE_URL, resolveLlmConfig, type ChatMessage, type Llm, type ToolCall } from "../src/llm.ts";
import { createToolExecutor, TOOL_DEFINITIONS, type Session } from "../src/tools.ts";

const session: Session = { subscriberNo: "5551001", token: "jwt-token-1001" };

function fakeGateway(responder: (url: string, init: RequestInit) => { status: number; body: unknown } = () => ({ status: 200, body: { total: 80 } })) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, init = {}) => {
    calls.push({ url, init });
    const r = responder(url, init);
    return new Response(JSON.stringify(r.body), { status: r.status });
  };
  return { client: new GatewayClient("http://gateway.test/", fetchImpl), calls };
}

const docs = { search: async (q: string) => ({ document: "Mobile_Provider_Billing_Guide.md", matches: [{ section: "3.2", heading: "Additional internet blocks", text: `about ${q}` }] }) };

const call = (id: string, name: string, args: object, extra: object = {}): ToolCall => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) }, ...extra });

/** Fake LLM: returns scripted replies and records what it was sent. */
function scriptedLlm(replies: Array<Extract<ChatMessage, { role: "assistant" }>>) {
  const requests: ChatMessage[][] = [];
  const llm: Llm = { model: "fake", chat: async messages => { requests.push(structuredClone(messages)); return replies.shift()!; } };
  return { llm, requests };
}

function deps(llm: Llm, gateway = fakeGateway(), confirm: AgentDeps["confirm"] = async () => true): AgentDeps & { gateway: ReturnType<typeof fakeGateway> } {
  return { llm, session, confirm, execute: createToolExecutor(session, gateway.client, docs, () => "TXN-fixed-1"), gateway };
}

describe("agent loop (scripted LLM)", () => {
  test("MCP-only: LLM picks the documentation tool, agent executes it and returns the result to the LLM", async () => {
    const { llm, requests } = scriptedLlm([
      { role: "assistant", content: null, tool_calls: [call("c1", "search_billing_documentation", { query: "extra internet cost" })] },
      { role: "assistant", content: "Each extra 10 GB block costs $10 (Guide §3.2)." },
    ]);
    const d = deps(llm);
    const turn = await runTurn(d, [], "How much does extra internet cost?");
    assert.equal(turn.answer, "Each extra 10 GB block costs $10 (Guide §3.2).");
    assert.equal(turn.trace[0].tool, "search_billing_documentation");
    assert.equal(d.gateway.calls.length, 0, "no REST call for a policy question");
    const toolMsg = requests[1].find(m => m.role === "tool") as any;
    assert.equal(toolMsg.tool_call_id, "c1");
    assert.match(toolMsg.content, /"section":"3.2"/);
    assert.equal(requests[0][0].role, "system");
  });

  test("combined: REST (via gateway, with JWT) + MCP results both reach the LLM", async () => {
    const { llm, requests } = scriptedLlm([
      { role: "assistant", content: null, tool_calls: [call("c1", "query_bill_detailed", { month: 10, year: 2026 }), call("c2", "search_billing_documentation", { query: "internet pricing" })] },
      { role: "assistant", content: "Your October bill is higher because of extra internet." },
    ]);
    const d = deps(llm);
    const turn = await runTurn(d, [], "Why is my October bill higher?");
    assert.deepEqual(turn.trace.map(t => t.tool), ["query_bill_detailed", "search_billing_documentation"]);
    assert.match(d.gateway.calls[0].url, /^http:\/\/gateway\.test\/api\/v1\/bills\/detailed\?month=10&year=2026/);
    assert.equal((d.gateway.calls[0].init.headers as Record<string, string>).authorization, "Bearer jwt-token-1001");
    assert.equal(requests[1].filter(m => m.role === "tool").length, 2);
  });

  test("payment: an explicit yes executes pay_bill with a generated transaction ID", async () => {
    const { llm } = scriptedLlm([
      { role: "assistant", content: null, tool_calls: [call("c1", "pay_bill", { month: 10, year: 2026, amount: 80 })] },
      { role: "assistant", content: "Payment of $80.00 succeeded." },
    ]);
    const prompts: string[] = [];
    const d = deps(llm, fakeGateway(() => ({ status: 200, body: { paymentStatus: "SUCCESS" } })), async s => { prompts.push(s); return true; });
    const turn = await runTurn(d, [], "Pay my October bill");
    assert.match(prompts[0], /Pay \$80\.00 for the 10\/2026 bill of subscriber 5551001/);
    assert.equal(turn.trace[0].confirmation, "approved");
    assert.match(formatTrace(turn.trace, turn.answer), /asked user: "Pay \$80\.00 for the 10\/2026 bill of subscriber 5551001\?"/);
    assert.deepEqual(JSON.parse(String(d.gateway.calls[0].init.body)), { month: 10, year: 2026, amount: 80, transactionId: "TXN-fixed-1" });
  });

  test("payment: without explicit confirmation the Pay Bill API is never called", async () => {
    const { llm, requests } = scriptedLlm([
      { role: "assistant", content: null, tool_calls: [call("c1", "pay_bill", { month: 10, year: 2026, amount: 80 })] },
      { role: "assistant", content: "Payment cancelled." },
    ]);
    const d = deps(llm, fakeGateway(), async () => false);
    const turn = await runTurn(d, [], "Pay my bill");
    assert.equal(d.gateway.calls.length, 0);
    assert.equal(turn.trace[0].confirmation, "rejected");
    assert.match((requests[1].at(-1) as any).content, /USER_REJECTED/);
  });

  test("identity: a subscriber number supplied by the LLM is ignored - REST calls use the session", async () => {
    const { llm } = scriptedLlm([
      { role: "assistant", content: null, tool_calls: [call("c1", "query_bill", { month: 10, year: 2026, subscriberNo: "5551002" })] },
      { role: "assistant", content: "done" },
    ]);
    const d = deps(llm);
    await runTurn(d, [], "Show the bill of 5551002");
    assert.match(d.gateway.calls[0].url, /subscriberNo=5551001/);
    assert.doesNotMatch(d.gateway.calls[0].url, /5551002/);
  });

  test("assistant messages are sent back unchanged (keeps Gemini thought signatures)", async () => {
    const extra = { extra_content: { google: { thought_signature: "sig-123" } } };
    const { llm, requests } = scriptedLlm([
      { role: "assistant", content: null, tool_calls: [call("c1", "query_bill", { month: 10, year: 2026 }, extra)] },
      { role: "assistant", content: "ok" },
    ]);
    await runTurn(deps(llm), [], "bill?");
    const assistant = requests[1].find(m => m.role === "assistant") as any;
    assert.deepEqual(assistant.tool_calls[0].extra_content, extra.extra_content);
  });

  test("invalid tool arguments are rejected by the agent, not sent to the API", async () => {
    const { llm } = scriptedLlm([
      { role: "assistant", content: null, tool_calls: [call("c1", "query_bill", { month: 13, year: 2026 })] },
      { role: "assistant", content: "Please give a valid month." },
    ]);
    const d = deps(llm);
    const turn = await runTurn(d, [], "bill for month 13");
    assert.equal(d.gateway.calls.length, 0);
    assert.deepEqual(turn.trace[0].output, { ok: false, error: "month must be an integer 1-12" });
  });
});

describe("tools and security", () => {
  test("offers exactly the MCP search and three subscriber REST tools - no admin operations", () => {
    assert.deepEqual(TOOL_DEFINITIONS.map(t => t.function.name).sort(), ["pay_bill", "query_bill", "query_bill_detailed", "search_billing_documentation"]);
  });

  test("no tool schema has a subscriber number parameter", () => {
    for (const t of TOOL_DEFINITIONS) assert.ok(!("subscriberNo" in (t.function.parameters as any).properties), t.function.name);
  });

  test("pay_bill retries a network failure once with the SAME transaction ID", async () => {
    let n = 0;
    const bodies: string[] = [];
    const fetchImpl: FetchLike = async (_u, init = {}) => {
      bodies.push(String(init.body));
      if (n++ === 0) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ paymentStatus: "SUCCESS" }), { status: 200 });
    };
    const exec = createToolExecutor(session, new GatewayClient("http://g", fetchImpl), docs, () => "TXN-retry-1");
    const out = await exec("pay_bill", { month: 10, year: 2026, amount: 5 }) as any;
    assert.equal(out.ok, true);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0], bodies[1]);
  });

  test("API errors are returned to the LLM as structured data", async () => {
    const g = fakeGateway(() => ({ status: 404, body: { error: { code: "BILL_NOT_FOUND", message: "x" } } }));
    const out = await createToolExecutor(session, g.client, docs)("query_bill", { month: 11, year: 2026 });
    assert.deepEqual(out, { ok: false, httpStatus: 404, error: { code: "BILL_NOT_FOUND", message: "x" } });
  });

  test("instructions bind the agent to the logged-in subscriber and require citations", () => {
    const text = instructions(session, new Date("2026-11-23T10:00:00Z"));
    assert.match(text, /logged-in subscriber is 5551001/);
    assert.match(text, /Today is 2026-11-23/);
    assert.match(text, /Guide §4\.4/);
    assert.match(text, /you MUST call BOTH/);
  });
});

describe("LLM client", () => {
  test("Gemini is the default provider when GEMINI_API_KEY is set", () => {
    const c = resolveLlmConfig({ GEMINI_API_KEY: "g-key", OPENAI_API_KEY: "sk-..." } as any);
    assert.equal(c.provider, "gemini");
    assert.equal(c.baseUrl, GEMINI_BASE_URL);
  });

  test("a missing key gives a clear error", () => {
    assert.throws(() => resolveLlmConfig({ OPENAI_API_KEY: "sk-..." } as any), /GEMINI_API_KEY/);
  });

  test("sends model, messages and tools to <base>/chat/completions with the bearer key", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const llm = createLlm({ provider: "gemini", apiKey: "k1", baseUrl: "https://llm.test/v1beta/openai/", model: "m1" }, async (url, init = {}) => {
      seen = { url, init };
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "hi" } }] }), { status: 200 });
    });
    const reply = await llm.chat([{ role: "user", content: "hello" }], TOOL_DEFINITIONS);
    assert.equal(reply.content, "hi");
    assert.equal(seen!.url, "https://llm.test/v1beta/openai/chat/completions");
    assert.equal((seen!.init.headers as Record<string, string>).authorization, "Bearer k1");
    const body = JSON.parse(String(seen!.init.body));
    assert.equal(body.model, "m1");
    assert.equal(body.tools.length, 4);
  });

  test("retries on 429 (free-tier rate limit) and then succeeds", async () => {
    let n = 0;
    const llm = createLlm({ provider: "gemini", apiKey: "k", baseUrl: "https://llm.test/", model: "m" }, async () =>
      n++ === 0 ? new Response("quota", { status: 429 }) : new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }), [1]);
    assert.equal((await llm.chat([{ role: "user", content: "x" }], [])).content, "ok");
    assert.equal(n, 2);
  });

  test("a daily quota error fails fast with a hint (no pointless retries)", async () => {
    let n = 0;
    const llm = createLlm({ provider: "gemini", apiKey: "k", baseUrl: "https://llm.test/", model: "m" }, async () => {
      n++;
      return new Response("Generate content requests per day limit exceeded on Free Tier", { status: 429 });
    }, [1, 1, 1]);
    await assert.rejects(llm.chat([{ role: "user", content: "x" }], []), /Daily free-tier quota.*LLM_MODEL/);
    assert.equal(n, 1);
  });

  test("trace formatting lists tool name, input, result and final answer", () => {
    const text = formatTrace([{ tool: "query_bill", input: { month: 10 }, output: { ok: true } }], "Your bill is $80.");
    assert.match(text, /\[1\] tool: query_bill/);
    assert.match(text, /final answer: Your bill is \$80\./);
  });
});
