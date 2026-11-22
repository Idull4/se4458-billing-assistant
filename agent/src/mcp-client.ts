// MCP client side of the agent (official MCP TypeScript SDK).
// Connects to the billing-docs MCP server over Streamable HTTP (MCP_URL) or starts it locally over stdio.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { fileURLToPath } from "node:url";

export const MCP_TOOL = "search_billing_documentation";

export interface DocsSearch {
  search(query: string, limit?: number): Promise<unknown>;
  close(): Promise<void>;
  description: string;
}

export async function connectMcp(mcpUrl?: string): Promise<DocsSearch> {
  const client = new Client({ name: "billing-assistant-agent", version: "1.0.0" });
  const transport = mcpUrl
    ? new StreamableHTTPClientTransport(new URL(mcpUrl))
    : new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../../mcp-server/src/server.ts", import.meta.url)), "--transport=stdio"],
        stderr: "ignore",
      });
  await client.connect(transport);

  // Discover the tool exposed by the server (fails fast if the server is wrong).
  const { tools } = await client.listTools();
  if (!tools.some(t => t.name === MCP_TOOL)) {
    throw new Error(`MCP server does not expose ${MCP_TOOL} (found: ${tools.map(t => t.name).join(", ")})`);
  }

  return {
    description: mcpUrl ? `Streamable HTTP ${mcpUrl}` : "stdio (local process)",
    async search(query, limit = 4) {
      const result = await client.callTool({ name: MCP_TOOL, arguments: { query, limit } });
      const text = (result.content as Array<{ type: string; text?: string }>).find(c => c.type === "text")?.text ?? "";
      if (result.isError) return { ok: false, error: text };
      try { return JSON.parse(text); } catch { return { text }; }
    },
    close: () => client.close(),
  };
}
