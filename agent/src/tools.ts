// Tools offered to the LLM and the code that executes them. The LLM only chooses a tool and its
// arguments; the agent validates and executes the call (MCP or REST via the API Gateway).
//
// Security decisions (enforced in code, not only in the prompt):
//  - No tool accepts a subscriber number. Identity always comes from the logged-in session (JWT),
//    so "show the bill of 5551002" cannot reach another subscriber's data.
//  - pay_bill requires explicit human confirmation in the CLI before the Pay Bill API is called
//    (Guide §5.2). A transaction ID is generated per confirmed payment and reused on a network retry (§5.3).
import { randomUUID } from "node:crypto";
import type { ApiResult, GatewayClient } from "./gateway-client.ts";
import type { ToolDefinition } from "./llm.ts";
import { MCP_TOOL, type DocsSearch } from "./mcp-client.ts";

export interface Session {
  subscriberNo: string;
  token: string;
}

/** Plain JSON-Schema subset accepted by both OpenAI and Gemini. */
const month = { type: "integer", description: "Billing month, 1-12" };
const year = { type: "integer", description: "Billing year, e.g. 2026" };

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: MCP_TOOL,
      description:
        "MCP tool: search the indexed Mobile Provider Billing Guide (pricing of phone and internet, bill calculation, due dates, " +
        "partial payments, late payments, disputes). Returns passages with section ids for citation. Contains no subscriber data. " +
        "Use short English keywords, e.g. 'extra internet block price'.",
      parameters: { type: "object", properties: { query: { type: "string", description: "English search keywords" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "query_bill",
      description: "Query Bill REST API (via API Gateway): the logged-in subscriber's stored bill for a month - total, paid amount, " +
        "remaining balance, status, due date. Returns BILL_NOT_FOUND if the bill has not been calculated yet.",
      parameters: { type: "object", properties: { month, year }, required: ["month", "year"] },
    },
  },
  {
    type: "function",
    function: {
      name: "query_bill_detailed",
      description: "Query Bill Detailed REST API (via API Gateway, authenticated): the logged-in subscriber's actual phone minutes, " +
        "internet MB/GB, charge breakdown and a page of usage events. Use it to explain why a bill is what it is.",
      parameters: {
        type: "object",
        properties: { month, year, page: { type: "integer", description: "Usage events page, default 1" }, pageSize: { type: "integer", description: "Usage events per page (1-50), default 5" } },
        required: ["month", "year"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pay_bill",
      description: "Pay Bill REST API (via API Gateway, authenticated): record a simulated full or partial payment for the logged-in " +
        "subscriber. The system asks the user for explicit confirmation before the payment is sent. Amount must not exceed the remaining balance.",
      parameters: { type: "object", properties: { month, year, amount: { type: "number", description: "Amount in USD (max 2 decimals)" } }, required: ["month", "year", "amount"] },
    },
  },
];

/** Tools that need explicit human confirmation before execution. */
export const NEEDS_CONFIRMATION = new Set(["pay_bill"]);

function toOutput(r: ApiResult) {
  return r.ok ? { ok: true, data: r.body } : { ok: false, httpStatus: r.status, error: r.body?.error ?? r.body };
}

const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;

function checkPeriod(a: any): string | null {
  if (!isInt(a?.month, 1, 12)) return "month must be an integer 1-12";
  if (!isInt(a?.year, 2000, 2100)) return "year must be an integer like 2026";
  return null;
}

export function createToolExecutor(session: Session, client: GatewayClient, docs: Pick<DocsSearch, "search">,
  newTransactionId = () => `TXN-${randomUUID()}`) {
  const handlers: Record<string, (args: any) => Promise<unknown>> = {
    [MCP_TOOL]: async a => {
      if (typeof a?.query !== "string" || !a.query.trim()) return { ok: false, error: "query is required" };
      return docs.search(a.query.trim());
    },
    query_bill: async a => {
      const bad = checkPeriod(a);
      return bad ? { ok: false, error: bad } : toOutput(await client.queryBill(session.subscriberNo, a.month, a.year));
    },
    query_bill_detailed: async a => {
      const bad = checkPeriod(a);
      if (bad) return { ok: false, error: bad };
      const page = isInt(a.page, 1, 1_000_000) ? a.page : 1;
      const pageSize = isInt(a.pageSize, 1, 50) ? a.pageSize : 5;
      return toOutput(await client.queryBillDetailed(session.token, a.month, a.year, page, pageSize));
    },
    pay_bill: async a => {
      const bad = checkPeriod(a);
      if (bad) return { ok: false, error: bad };
      if (typeof a.amount !== "number" || !(a.amount > 0)) return { ok: false, error: "amount must be a positive number" };
      const transactionId = newTransactionId();
      const body = { month: a.month, year: a.year, amount: a.amount, transactionId };
      let result: ApiResult;
      try {
        result = await client.payBill(session.token, body);
      } catch {
        // Network failure: retry once with the SAME transaction ID (the API rejects duplicates).
        result = await client.payBill(session.token, body);
      }
      return { transactionId, ...toOutput(result) };
    },
  };

  return async function execute(name: string, args: unknown): Promise<unknown> {
    const handler = handlers[name];
    if (!handler) return { ok: false, error: `Unknown tool: ${name}` };
    try {
      return await handler(args ?? {});
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}
