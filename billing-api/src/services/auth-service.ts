// Authentication service: credential check, JWT issuing and verification.
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { JWT_ISSUER } from "../config/config.ts";
import type { Principal } from "../domain/models.ts";
import type { Repository } from "../repositories/repository.ts";
import { ApiError } from "../shared/api-error.ts";

export class AuthService {
  private repo: Repository;
  private secret: string;
  private ttlSeconds: number;

  constructor(repo: Repository, secret: string, ttlSeconds = 3600) {
    this.repo = repo;
    this.secret = secret;
    this.ttlSeconds = ttlSeconds;
  }

  async login(subscriberNo: string, password: string) {
    const s = await this.repo.findSubscriber(subscriberNo);
    if (!s || !(await bcrypt.compare(password, s.passwordHash))) {
      throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid subscriber number or password.");
    }
    const accessToken = jwt.sign({ role: s.role, name: s.name }, this.secret,
      { subject: s.subscriberNo, issuer: JWT_ISSUER, expiresIn: this.ttlSeconds, algorithm: "HS256" });
    return { accessToken, tokenType: "Bearer", expiresIn: this.ttlSeconds, subscriberNo: s.subscriberNo, role: s.role };
  }

  /** Verify signature, issuer and expiry; return the caller. */
  verify(token: string): Principal {
    try {
      const claims = jwt.verify(token, this.secret, { issuer: JWT_ISSUER, algorithms: ["HS256"] }) as jwt.JwtPayload;
      return { subscriberNo: String(claims.sub), role: claims.role };
    } catch {
      throw new ApiError(401, "UNAUTHORIZED", "Invalid or expired token.");
    }
  }
}
