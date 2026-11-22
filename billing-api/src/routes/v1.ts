// Version 1 routes (/api/v1). A future /api/v2 router can be mounted next to it.
import { Router, type NextFunction, type Request, type Response } from "express";
import swaggerUi from "swagger-ui-express";
import YAML from "yaml";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AuthController } from "../controllers/auth-controller.ts";
import type { BillController } from "../controllers/bill-controller.ts";
import type { UsageController } from "../controllers/usage-controller.ts";
import { authenticate } from "../middleware/auth.ts";
import type { AuthService } from "../services/auth-service.ts";

type Handler = (req: Request, res: Response) => Promise<unknown>;
/** Forward async errors to the error-handling middleware. */
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

export interface V1Deps {
  authService: AuthService;
  authController: AuthController;
  usageController: UsageController;
  billController: BillController;
}

export function createV1Router(d: V1Deps) {
  const r = Router();
  const adminOnly = authenticate(d.authService, ["admin"]);
  const subscriberOrAdmin = authenticate(d.authService, ["subscriber", "admin"]);

  r.post("/auth/login", wrap(d.authController.login));
  r.post("/usage", adminOnly, wrap(d.usageController.addUsage));
  r.post("/bills/calculate", adminOnly, wrap(d.billController.calculate));
  r.get("/bills", wrap(d.billController.query)); // public (spec: Query Bill, authentication NO)
  r.get("/bills/detailed", subscriberOrAdmin, wrap(d.billController.queryDetailed));
  r.post("/bills/pay", subscriberOrAdmin, wrap(d.billController.pay));

  // OpenAPI document + Swagger UI
  const spec = YAML.parse(readFileSync(fileURLToPath(new URL("../../openapi.yaml", import.meta.url)), "utf8"));
  r.get("/openapi.json", (_req, res) => { res.json(spec); });
  r.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));
  return r;
}
