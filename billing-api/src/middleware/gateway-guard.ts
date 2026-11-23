// Gateway guard: when GATEWAY_SHARED_SECRET is set (cloud deployment), every API request must carry the
// X-Gateway-Key header that only the API Gateway (Kong) adds. Direct calls that bypass the gateway get 403.
// Locally the secret is unset and the API port is not published at all, so the guard is not needed there.
import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { ApiError } from "../shared/api-error.ts";

export const GATEWAY_HEADER = "x-gateway-key";

export function gatewayGuard(secret?: string) {
  const expected = secret ? Buffer.from(secret) : null;
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!expected) return next();
    const given = Buffer.from(String(req.headers[GATEWAY_HEADER] ?? ""));
    if (given.length === expected.length && timingSafeEqual(given, expected)) return next();
    next(new ApiError(403, "GATEWAY_REQUIRED", "Requests must go through the API Gateway."));
  };
}
