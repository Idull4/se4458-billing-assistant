// Entry point: load config, migrate (and optionally seed) the database, start HTTP server.
import { createApp } from "./app.ts";
import { loadConfig } from "./config/config.ts";
import { seed } from "./db/seed.ts";
import { PgRepository } from "./repositories/pg-repository.ts";

async function main() {
  const config = loadConfig();
  const repo = new PgRepository(config.databaseUrl);

  // Retry while the database container starts.
  for (let attempt = 1; ; attempt++) {
    try {
      await repo.migrate(config.schemaPath);
      break;
    } catch (error) {
      if (attempt >= 30) throw error;
      console.log(`Waiting for database (${attempt})...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (config.seedOnStart) await seed(repo, { onlyIfEmpty: true });

  createApp({ repo, jwtSecret: config.jwtSecret, tokenTtlSeconds: config.tokenTtlSeconds, logRequests: true, gatewaySecret: config.gatewaySecret })
    .listen(config.port, () => console.log(`Billing API listening on :${config.port} (Swagger UI: /api/v1/docs)`));
}

main().catch(error => {
  console.error("Failed to start:", error instanceof Error ? error.message : error);
  process.exit(1);
});
