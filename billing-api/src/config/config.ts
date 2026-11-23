// Central configuration from environment variables.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const JWT_ISSUER = "billing-api";

export interface Config {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  tokenTtlSeconds: number;
  seedOnStart: boolean;
  schemaPath: string;
  gatewaySecret?: string;
}

/** db/schema.sql is at the repo root locally and next to the app inside the container image. */
export function findSchemaPath(): string {
  const candidates = ["../../../db/schema.sql", "../../db/schema.sql"].map(p => fileURLToPath(new URL(p, import.meta.url)));
  const found = candidates.find(existsSync);
  if (!found) throw new Error(`db/schema.sql not found (looked in ${candidates.join(", ")})`);
  return found;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET is required (see .env.example).");
  return {
    port: Number(env.PORT ?? 3000),
    databaseUrl: env.DATABASE_URL ?? "postgres://billing:billing@localhost:5432/billing",
    jwtSecret: env.JWT_SECRET,
    tokenTtlSeconds: Number(env.TOKEN_TTL_SECONDS ?? 3600),
    seedOnStart: env.SEED_ON_START === "true",
    schemaPath: findSchemaPath(),
    gatewaySecret: env.GATEWAY_SHARED_SECRET || undefined,
  };
}
