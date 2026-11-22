// MCP server tests: chunking, indexing, three distinct retrieval queries, and real MCP calls
// over stdio and Streamable HTTP. No API key or cloud needed.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { chunkMarkdown, DocumentStore, toFtsQuery, defaultDocumentPath } from "../src/document-store.ts";

const serverPath = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "billing-mcp-"));
// Best-effort cleanup: on Windows the SQLite files can still be locked by a just-closed process.
after(() => {
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* temp dir, OS cleans it */ }
});

describe("chunking and indexing", () => {
  test("splits the guide into subsections with section ids and headings", () => {
    const { documentId, chunks } = chunkMarkdown(`# Guide\n**Document ID:** DOC-1\n## 1. Scope\nScope text.\n## 2. Phone\n### 2.1 Included minutes\nFirst minutes free.\n### 2.2 Additional minutes\nBlocks cost $10.`);
    assert.equal(documentId, "DOC-1");
    assert.deepEqual(chunks.map(c => c.section), ["1", "2.1", "2.2"]);
    assert.equal(chunks[2].heading, "Additional minutes");
    assert.equal(chunks[2].parentHeading, "Phone");
  });

  test("rejects a document without numbered sections", () => {
    assert.throws(() => chunkMarkdown("# Title\nno sections here"), /sections/);
  });

  test("user input cannot inject FTS5 syntax", () => {
    assert.equal(toFtsQuery('internet" OR text:* NEAR('), '"internet" OR "text" OR "near"');
    assert.equal(toFtsQuery("what is the"), null);
  });

  test("index is built once and reused while the document is unchanged; rebuilt when it changes", () => {
    const doc = join(tmp, "guide.md");
    const db = join(tmp, "index.db");
    writeFileSync(doc, "# G\n**Document ID:** X\n## 1. Alpha\nfirst version\n");
    const first = new DocumentStore(db, doc);
    assert.equal(first.rebuilt, true);
    first.close();
    const second = new DocumentStore(db, doc);
    assert.equal(second.rebuilt, false);
    second.close();
    writeFileSync(doc, "# G\n**Document ID:** X\n## 1. Alpha\nsecond version\n");
    const third = new DocumentStore(db, doc);
    assert.equal(third.rebuilt, true);
    assert.equal(third.search("second").matches.length, 1);
    third.close();
  });
});

describe("retrieval over Mobile_Provider_Billing_Guide.md", () => {
  const store = new DocumentStore(":memory:", defaultDocumentPath);
  after(() => store.close());
  const sections = (q: string) => store.search(q, 3).matches.map(m => m.section);

  test("query 1 - extra internet cost returns §3.2 / §8.1", () => {
    const s = sections("How much does extra internet cost?");
    assert.ok(s.includes("3.2") && s.includes("8.1"), s.join(","));
  });

  test("query 2 - bill due date returns §6.1 first", () => {
    assert.equal(sections("When is my bill due?")[0], "6.1");
  });

  test("query 3 - disputing a charge returns dispute sections (§7 / §8.4)", () => {
    const s = sections("How can I dispute a charge?");
    assert.ok(s.includes("7.1") && s.includes("8.4"), s.join(","));
  });

  test("results include document, section, heading and text (Guide §9 format)", () => {
    const r = store.search("partial payment", 1);
    assert.equal(r.document, "Mobile_Provider_Billing_Guide.md");
    assert.equal(r.documentId, "MOB-BILLING-2026-01");
    const m = r.matches[0];
    assert.ok(m.section && m.heading && m.text && m.score > 0);
  });

  test("unrelated or empty queries return no matches", () => {
    assert.equal(store.search("pizza recipe").matches.length, 0);
    assert.equal(store.search("what is the").matches.length, 0);
  });
});

async function callSearch(client: Client, query: string) {
  const result = await client.callTool({ name: "search_billing_documentation", arguments: { query, limit: 3 } });
  return JSON.parse((result.content as Array<{ text: string }>)[0].text);
}

describe("MCP protocol over stdio", () => {
  let client: Client;
  before(async () => {
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StdioClientTransport({
      command: process.execPath,
      args: [serverPath, "--transport=stdio"],
      env: { ...process.env, INDEX_PATH: join(tmp, "stdio-index.db") } as Record<string, string>,
      stderr: "ignore",
    }));
  });
  after(async () => { await client?.close(); });

  test("lists the search_billing_documentation tool with its input schema", async () => {
    const { tools } = await client.listTools();
    const tool = tools.find(t => t.name === "search_billing_documentation");
    assert.ok(tool);
    assert.deepEqual(tool.inputSchema.required, ["query"]);
  });

  test("tool call returns cited passages", async () => {
    const r = await callSearch(client, "extra internet block price");
    const s = r.matches.map((m: { section: string }) => m.section);
    assert.ok(s.includes("3.2"), s.join(","));
  });

  test("invalid input (empty query) is rejected", async () => {
    const result = await client.callTool({ name: "search_billing_documentation", arguments: { query: "" } });
    assert.equal(result.isError, true);
  });
});

describe("MCP protocol over Streamable HTTP", () => {
  let proc: ChildProcess;
  let client: Client;
  const port = 34000 + Math.floor(Math.random() * 1000);
  before(async () => {
    proc = spawn(process.execPath, [serverPath, "--transport=http"], {
      env: { ...process.env, PORT: String(port), INDEX_PATH: join(tmp, "http-index.db") }, stdio: "ignore",
    });
    for (let i = 0; i < 50; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* starting */ }
      await new Promise(r => setTimeout(r, 100));
    }
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
  });
  after(async () => {
    await client?.close();
    if (proc && proc.exitCode === null) {
      const exited = new Promise(r => proc.once("exit", r));
      proc.kill();
      await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]);
    }
  });

  test("tool call over HTTP returns cited passages", async () => {
    const r = await callSearch(client, "When is my bill due?");
    assert.equal(r.matches[0].section, "6.1");
  });
});
