// One log line per request: method, path, status, duration (disabled in tests).
import type { NextFunction, Request, Response } from "express";

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const requestId = req.headers["x-request-id"] ?? "-";
    console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl.split("?")[0]} ${res.statusCode} ${ms.toFixed(1)}ms rid=${requestId}`);
  });
  next();
}
