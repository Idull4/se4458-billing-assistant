// Composition root: wires repository -> services -> controllers -> routes -> middleware.
//
//   routes/       URL + HTTP method -> controller, auth requirements per route
//   middleware/   authentication/authorization, error handling, request logging
//   controllers/  HTTP request/response <-> validated service calls
//   validation/   input validation
//   services/     business logic (billing rules, payments, auth)
//   repositories/ data access (PostgreSQL; in-memory for unit tests)
//   domain/       entities and pure billing rules
//   dto/          response representations
import express from "express";
import { AuthController } from "./controllers/auth-controller.ts";
import { BillController } from "./controllers/bill-controller.ts";
import { UsageController } from "./controllers/usage-controller.ts";
import { errorHandler, notFound } from "./middleware/error-handler.ts";
import { requestLogger } from "./middleware/request-logger.ts";
import type { Repository } from "./repositories/repository.ts";
import { createV1Router } from "./routes/v1.ts";
import { AuthService } from "./services/auth-service.ts";
import { BillingService } from "./services/billing-service.ts";

export { JWT_ISSUER } from "./config/config.ts";

export interface AppOptions {
  repo: Repository;
  jwtSecret: string;
  tokenTtlSeconds?: number;
  logRequests?: boolean;
}

export function createApp(opts: AppOptions) {
  const authService = new AuthService(opts.repo, opts.jwtSecret, opts.tokenTtlSeconds);
  const billingService = new BillingService(opts.repo);

  const app = express();
  app.disable("x-powered-by");
  if (opts.logRequests) app.use(requestLogger);
  app.use(express.json({ limit: "100kb" }));

  app.get("/health", (_req, res) => { res.json({ status: "ok" }); });
  app.use("/api/v1", createV1Router({
    authService,
    authController: new AuthController(authService),
    usageController: new UsageController(billingService),
    billController: new BillController(billingService),
  }));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
