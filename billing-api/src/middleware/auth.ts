// Authentication and authorization middleware.
import type { NextFunction, Request, Response } from "express";
import type { Principal, Role } from "../domain/models.ts";
import type { AuthService } from "../services/auth-service.ts";
import { ApiError } from "../shared/api-error.ts";
import { subscriberNo } from "../validation/validators.ts";

export type AuthedRequest = Request & { principal?: Principal };

/** Require a valid Bearer JWT with one of the given roles (the gateway validates it too: defence in depth). */
export function authenticate(auth: AuthService, roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token) return next(new ApiError(401, "UNAUTHORIZED", "Missing Bearer token."));
    try {
      const principal = auth.verify(token);
      if (!roles.includes(principal.role)) {
        return next(new ApiError(403, "FORBIDDEN", `This operation requires role: ${roles.join(" or ")}.`));
      }
      (req as AuthedRequest).principal = principal;
      next();
    } catch (error) {
      next(error);
    }
  };
}

/**
 * Resource ownership: subscribers may only act on their own account. The subscriber number comes from
 * the token; a different number in the request is rejected, so a client (or an AI agent) cannot read
 * someone else's data just by supplying their number. Admins must name the subscriber explicitly.
 */
export function resolveSubscriber(principal: Principal, requested: unknown): string {
  if (principal.role === "admin") return subscriberNo(requested);
  if (requested !== undefined && requested !== "" && requested !== principal.subscriberNo) {
    throw new ApiError(403, "FORBIDDEN", "Subscribers can only access their own account.");
  }
  return principal.subscriberNo;
}
