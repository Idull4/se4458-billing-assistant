// Minimal .env loader (repo root or agent folder); existing environment variables win.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function loadEnv() {
  for (const p of ["../.env", "../../.env"].map(x => fileURLToPath(new URL(x, import.meta.url)))) {
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
