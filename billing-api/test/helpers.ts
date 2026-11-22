import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import request from "supertest";
import { createApp, JWT_ISSUER } from "../src/app.ts";
import { MemoryRepository } from "../src/repositories/memory-repository.ts";
import { BillingService } from "../src/services/billing-service.ts";

export const SECRET = "test-secret";
export const PASSWORD = "Passw0rd!";
const hash = bcrypt.hashSync(PASSWORD, 4);

export function token(subscriberNo: string, role: "subscriber" | "admin", secret = SECRET, expiresIn = 600) {
  return jwt.sign({ role }, secret, { subject: subscriberNo, issuer: JWT_ISSUER, expiresIn });
}

export const ADMIN = () => `Bearer ${token("admin", "admin")}`;
export const SUB1 = () => `Bearer ${token("5551001", "subscriber")}`;
export const SUB2 = () => `Bearer ${token("5551002", "subscriber")}`;

/** Fresh app + in-memory data: 5551001 has an Oct 2026 bill of $80 (1,350 min, 35 GB). */
export async function setup() {
  const repo = new MemoryRepository();
  repo.addSubscriber({ subscriberNo: "admin", name: "Admin", passwordHash: hash, role: "admin" });
  const s1 = repo.addSubscriber({ subscriberNo: "5551001", name: "Ayse", passwordHash: hash, role: "subscriber" });
  repo.addSubscriber({ subscriberNo: "5551002", name: "Mehmet", passwordHash: hash, role: "subscriber" });
  const p = { subscriberId: s1.id, year: 2026, month: 10 };
  for (let i = 0; i < 135; i++) await repo.addUsage(p, "PHONE", 10);
  // Aggregate events keep tests fast; totals are what matter for calculation.
  await repo.addUsage(p, "INTERNET", 35_000);
  await new BillingService(repo).calculate({ subscriberNo: "5551001", year: 2026, month: 10 });
  const app = createApp({ repo, jwtSecret: SECRET });
  return { repo, app, http: request(app) };
}
