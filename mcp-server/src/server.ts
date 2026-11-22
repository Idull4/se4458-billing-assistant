// MCP server exposing search_billing_documentation over the indexed billing guide.
// Transports: stdio (local MCP clients, tests) and Streamable HTTP (cloud deployment).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";
import { DocumentStore } from "./document-store.ts";

export function createMcpServer(store: DocumentStore) {
  const server = new McpServer({ name: "billing-docs-mcp", version: "1.0.0" });

  server.registerTool(
    "search_billing_documentation",
    {
      title: "Search billing documentation",
      description:
        "Search the indexed Mobile Provider Billing Guide (policies: phone and internet pricing, bill calculation, " +
        "due dates, partial payments, late payments, disputes). Returns matching passages with section id and heading " +
        "for citation. Contains NO subscriber data; use the Billing REST API for live bills, usage and payments. " +
        "Use specific English keywords, e.g. 'extra internet block price'.",
      inputSchema: {
        query: z.string().trim().min(1).max(500).describe("Search terms in English, e.g. 'bill due date'"),
        limit: z.number().int().min(1).max(10).default(5).describe("Maximum number of passages"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const result = store.search(query, limit);
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
    },
  );

  return server;
}

async function main() {
  const transport = (process.argv.find(a => a.startsWith("--transport="))?.split("=")[1] ?? process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  // Index once at startup (skipped when the document is unchanged).
  const store = new DocumentStore();
  console.error(`Index ready: ${store.chunkCount} chunks from ${store.documentName} (${store.rebuilt ? "rebuilt" : "reused"})`);

  if (transport === "stdio") {
    await createMcpServer(store).connect(new StdioServerTransport());
    console.error("billing-docs-mcp running on stdio");
    return;
  }

  // Streamable HTTP, stateless: a fresh server/transport per request.
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  app.get("/health", (_req, res) => { res.json({ status: "ok", chunks: store.chunkCount }); });
  app.post("/mcp", async (req, res) => {
    const server = createMcpServer(store);
    const http = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { http.close(); server.close(); });
    try {
      await server.connect(http);
      await http.handleRequest(req, res, req.body);
    } catch (error) {
      console.error(error);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });
  const notAllowed = (_req: express.Request, res: express.Response) => {
    res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  };
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  const port = Number(process.env.PORT ?? 3001);
  app.listen(port, () => console.error(`billing-docs-mcp (Streamable HTTP) on :${port}/mcp`));
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/server.ts")) {
  main().catch(error => {
    console.error("Failed to start MCP server", error);
    process.exit(1);
  });
}
