// Test data. Usage is inserted in bulk with SQL (one row per Add Usage event, same as the API
// would create) because recording 35,000 x 1 MB events through HTTP is impractical.
// Bills are then produced by the real Calculate Bill business logic.
import bcrypt from "bcryptjs";
import { fileURLToPath } from "node:url";
import { PgRepository } from "../repositories/pg-repository.ts";
import { BillingService } from "../services/billing-service.ts";
import { findSchemaPath } from "../config/config.ts";

export const DEMO_PASSWORD = "Passw0rd!";

interface Usage { subscriberNo: string; year: number; month: number; minutes: number; mb: number; calculate: boolean }

export const USERS = [
  { subscriberNo: "admin", name: "Billing Administrator", role: "admin" },
  { subscriberNo: "5551001", name: "Ayse Yilmaz", role: "subscriber" },
  { subscriberNo: "5551002", name: "Mehmet Demir", role: "subscriber" },
];

export const USAGE: Usage[] = [
  // 5551001: September is a normal month, October is higher because of extra internet.
  { subscriberNo: "5551001", year: 2026, month: 9, minutes: 800, mb: 18_000, calculate: true }, // $0 + $50 = $50
  { subscriberNo: "5551001", year: 2026, month: 10, minutes: 1_350, mb: 35_000, calculate: true }, // $10 + $70 = $80 (Guide §4.3)
  { subscriberNo: "5551001", year: 2026, month: 11, minutes: 200, mb: 4_000, calculate: false }, // usage exists, bill not calculated yet
  // 5551002: October bill, partially paid below.
  { subscriberNo: "5551002", year: 2026, month: 10, minutes: 2_010, mb: 21_500, calculate: true }, // $20 + $60 = $80
];

export async function seed(repo: PgRepository, opts: { onlyIfEmpty?: boolean } = {}) {
  const db = repo.pool;
  if (opts.onlyIfEmpty) {
    const { rows } = await db.query("SELECT count(*)::int AS c FROM subscribers");
    if (rows[0].c > 0) {
      console.log("Seed skipped: data already present.");
      return;
    }
  }
  await db.query("TRUNCATE payments, bills, usage_events, subscribers RESTART IDENTITY CASCADE");
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  for (const u of USERS) {
    await db.query("INSERT INTO subscribers (subscriber_no, name, password_hash, role) VALUES ($1,$2,$3,$4)",
      [u.subscriberNo, u.name, hash, u.role]);
  }
  for (const u of USAGE) {
    const params = [u.subscriberNo, u.year, u.month];
    await db.query(
      `INSERT INTO usage_events (subscriber_id, year, month, usage_type, quantity, created_at)
       SELECT s.id, $2::int, $3::int, 'PHONE', 10, make_timestamptz($2::int, $3::int, 1, 8, 0, 0, 'UTC') + (g * interval '7 minutes')
       FROM subscribers s, generate_series(1, $4::int) g WHERE s.subscriber_no = $1`,
      [...params, u.minutes / 10]);
    await db.query(
      `INSERT INTO usage_events (subscriber_id, year, month, usage_type, quantity, created_at)
       SELECT s.id, $2::int, $3::int, 'INTERNET', 1, make_timestamptz($2::int, $3::int, 1, 8, 0, 0, 'UTC') + (g * interval '1 minute')
       FROM subscribers s, generate_series(1, $4::int) g WHERE s.subscriber_no = $1`,
      [...params, u.mb]);
  }
  const service = new BillingService(repo);
  for (const u of USAGE.filter(x => x.calculate)) {
    await service.calculate({ subscriberNo: u.subscriberNo, year: u.year, month: u.month });
  }
  await service.pay({ subscriberNo: "5551002", year: 2026, month: 10, amount: 30, transactionId: "SEED-TXN-0001" });
  console.log(`Seed complete. Users: ${USERS.map(u => u.subscriberNo).join(", ")} (password: ${DEMO_PASSWORD})`);
}

// `npm run seed` resets the database to the demo data.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const repo = new PgRepository(process.env.DATABASE_URL ?? "postgres://billing:billing@localhost:5432/billing");
  repo.migrate(findSchemaPath()).then(() => seed(repo)).then(() => repo.close()).catch(e => { console.error(e); process.exit(1); });
}
