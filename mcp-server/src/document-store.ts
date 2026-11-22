// Indexed billing guide. Adapted from the course reference (southriver/MCP document-store.ts):
// chunk the Markdown, store chunks in a SQLite FTS5 index, rank with BM25.
// The index is built once and rebuilt only when the source document (or chunker) changes.
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Repo layout: <root>/docs/...; container image: <app>/docs/...
export const defaultDocumentPath = process.env.BILLING_GUIDE_PATH
  ?? ["../../docs/Mobile_Provider_Billing_Guide.md", "../docs/Mobile_Provider_Billing_Guide.md"]
    .map(p => fileURLToPath(new URL(p, import.meta.url))).find(existsSync)
  ?? fileURLToPath(new URL("../../docs/Mobile_Provider_Billing_Guide.md", import.meta.url));
const defaultIndexPath = process.env.INDEX_PATH ?? fileURLToPath(new URL("../data/billing-index.db", import.meta.url));

const CHUNKER_VERSION = "billing-chunker-v1";
const MAX_WORDS = 250;

// Question words that carry no meaning for keyword search.
const STOP_WORDS = new Set((
  "a an the is are was were be been to of in on for and or with what whats how much many does do did can could " +
  "i my me mine you your we our it its this that these those please tell explain about why when where which who " +
  "will would should there their them if than then so any some get got have has had"
).split(" "));

export interface Chunk {
  section: string;
  heading: string;
  parentHeading: string;
  text: string;
}

export interface SearchMatch extends Chunk {
  score: number;
}

/** Split the guide into one chunk per `###` subsection (or per `##` section without subsections). */
export function chunkMarkdown(source: string): { title: string; documentId: string; chunks: Chunk[] } {
  const title = source.match(/^# (.+)$/m)?.[1]?.trim() ?? "Billing guide";
  const documentId = source.match(/\*\*Document ID:\*\*\s*([^\s]+)/)?.[1] ?? "unknown";
  const chunks: Chunk[] = [];
  let parentNo = "", parentHeading = "";
  let current: { section: string; heading: string; lines: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const words = current.lines.join("\n").trim().split(/\s+/).filter(Boolean);
    for (let start = 0; start < words.length; start += MAX_WORDS) {
      chunks.push({ section: current.section, heading: current.heading, parentHeading, text: words.slice(start, start + MAX_WORDS).join(" ") });
    }
    current = null;
  };

  for (const line of source.split(/\r?\n/)) {
    const h2 = line.match(/^## (\d+)\.\s+(.+)$/);
    const h3 = line.match(/^### (\d+(?:\.\d+)+)\s+(.+)$/);
    if (h2) {
      flush();
      parentNo = h2[1];
      parentHeading = h2[2].trim();
      current = { section: parentNo, heading: parentHeading, lines: [] };
    } else if (h3) {
      flush();
      current = { section: h3[1], heading: h3[2].trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  if (!chunks.length) throw new Error("Billing guide must contain '## N. Heading' sections.");
  return { title, documentId, chunks };
}

/** Turn free text into a safe FTS5 expression (each token quoted, OR-combined). */
export function toFtsQuery(query: string): string | null {
  const tokens = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter(t => !STOP_WORDS.has(t)))].slice(0, 30);
  return tokens.length ? tokens.map(t => `"${t}"`).join(" OR ") : null;
}

export class DocumentStore {
  db: DatabaseSync;
  documentName: string;
  documentId = "";
  title = "";
  rebuilt = false;

  constructor(indexPath = defaultIndexPath, documentPath = defaultDocumentPath) {
    if (indexPath !== ":memory:") mkdirSync(dirname(indexPath), { recursive: true });
    this.documentName = basename(documentPath);
    this.db = new DatabaseSync(indexPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5(
        section UNINDEXED, heading, parent_heading, text,
        tokenize='porter unicode61'
      );
    `);
    const source = readFileSync(documentPath, "utf8");
    const { title, documentId, chunks } = chunkMarkdown(source);
    this.title = title;
    this.documentId = documentId;
    const hash = createHash("sha256").update(CHUNKER_VERSION + "\n" + source).digest("hex");
    const previous = this.db.prepare("SELECT value FROM metadata WHERE key = 'sourceHash'").get() as { value?: string } | undefined;
    if (previous?.value === hash) return; // index is current: no re-indexing

    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM chunks");
      const insert = this.db.prepare("INSERT INTO chunks(section, heading, parent_heading, text) VALUES (?, ?, ?, ?)");
      for (const c of chunks) insert.run(c.section, c.heading, c.parentHeading, c.text);
      this.db.prepare("INSERT OR REPLACE INTO metadata(key, value) VALUES ('sourceHash', ?)").run(hash);
      this.db.exec("COMMIT");
      this.rebuilt = true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  get chunkCount(): number {
    return Number((this.db.prepare("SELECT count(*) AS c FROM chunks").get() as { c: number }).c);
  }

  search(query: string, limit = 5) {
    const expression = toFtsQuery(query);
    const base = { document: this.documentName, documentId: this.documentId, query };
    if (!expression) {
      return { ...base, matches: [] as SearchMatch[], note: "No searchable terms. Use specific words such as 'extra internet price' or 'due date'." };
    }
    // Heading matches weigh more than body matches. bm25(): lower = better; we expose a positive score.
    const rows = this.db.prepare(`
      SELECT section, heading, parent_heading AS parentHeading, text, bm25(chunks, 0.0, 3.0, 1.5, 1.0) AS rank
      FROM chunks WHERE chunks MATCH ? ORDER BY rank, rowid LIMIT ?
    `).all(expression, limit) as unknown as Array<Chunk & { rank: number }>;
    const matches: SearchMatch[] = rows.map(r => ({
      section: r.section, heading: r.heading, parentHeading: r.parentHeading, text: r.text,
      score: Math.round(-r.rank * 1000) / 1000,
    }));
    return { ...base, matches, note: "Keyword (BM25) search over the indexed guide; cite results as §<section>." };
  }

  close() {
    this.db.close();
  }
}
