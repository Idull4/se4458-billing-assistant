// PostgreSQL repository (production).
import pg from "pg";
import { readFileSync } from "node:fs";
import type { BillStatus, UsageType } from "../domain/billing-rules.ts";
import type { Bill, NewBill, Payment, Period, Repository, Subscriber, TxRepository, UsageEvent } from "./repository.ts";

type Queryable = pg.Pool | pg.PoolClient;

const num = (v: unknown) => Number(v);
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

function toBill(r: any): Bill {
  return {
    id: r.id,
    subscriberId: r.subscriber_id,
    year: r.year,
    month: r.month,
    phoneMinutes: r.phone_minutes,
    internetMb: r.internet_mb,
    phoneCharge: num(r.phone_charge),
    internetCharge: num(r.internet_charge),
    total: num(r.total),
    paidAmount: num(r.paid_amount),
    status: r.status,
    dueDate: r.due_date instanceof Date ? r.due_date.toISOString().slice(0, 10) : String(r.due_date),
    calculatedAt: iso(r.calculated_at),
  };
}

const toEvent = (r: any): UsageEvent => ({ id: num(r.id), usageType: r.usage_type, quantity: r.quantity, createdAt: iso(r.created_at) });
const toPayment = (r: any): Payment => ({ id: r.id, billId: r.bill_id, transactionId: r.transaction_id, amount: num(r.amount), createdAt: iso(r.created_at) });

// Return DATE columns as plain 'YYYY-MM-DD' strings (no timezone shifting).
pg.types.setTypeParser(1082, v => v);

export class PgRepository implements Repository {
  pool: pg.Pool;

  constructor(connectionString: string) {
    const ssl = /sslmode=require/.test(connectionString) ? { rejectUnauthorized: false } : undefined;
    this.pool = new pg.Pool({ connectionString: connectionString.replace(/[?&]sslmode=require/, ""), ssl });
  }

  async migrate(schemaPath: string) {
    await this.pool.query(readFileSync(schemaPath, "utf8"));
  }

  async findSubscriber(subscriberNo: string): Promise<Subscriber | null> {
    const { rows } = await this.pool.query("SELECT * FROM subscribers WHERE subscriber_no = $1", [subscriberNo]);
    const r = rows[0];
    return r ? { id: r.id, subscriberNo: r.subscriber_no, name: r.name, passwordHash: r.password_hash, role: r.role } : null;
  }

  async addUsage(p: Period, type: UsageType, quantity: number) {
    const { rows } = await this.pool.query(
      "INSERT INTO usage_events (subscriber_id, year, month, usage_type, quantity) VALUES ($1,$2,$3,$4,$5) RETURNING *",
      [p.subscriberId, p.year, p.month, type, quantity],
    );
    return toEvent(rows[0]);
  }

  async usageTotals(p: Period) {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(quantity) FILTER (WHERE usage_type = 'PHONE'), 0) AS phone,
              COALESCE(SUM(quantity) FILTER (WHERE usage_type = 'INTERNET'), 0) AS internet
       FROM usage_events WHERE subscriber_id = $1 AND year = $2 AND month = $3`,
      [p.subscriberId, p.year, p.month],
    );
    return { phoneMinutes: num(rows[0].phone), internetMb: num(rows[0].internet) };
  }

  async countUsageEvents(p: Period) {
    const { rows } = await this.pool.query(
      "SELECT count(*) AS c FROM usage_events WHERE subscriber_id = $1 AND year = $2 AND month = $3",
      [p.subscriberId, p.year, p.month],
    );
    return num(rows[0].c);
  }

  async listUsageEvents(p: Period, offset: number, limit: number) {
    const { rows } = await this.pool.query(
      `SELECT * FROM usage_events WHERE subscriber_id = $1 AND year = $2 AND month = $3
       ORDER BY created_at DESC, id DESC OFFSET $4 LIMIT $5`,
      [p.subscriberId, p.year, p.month, offset, limit],
    );
    return rows.map(toEvent);
  }

  private async bill(db: Queryable, p: Period, lock: boolean) {
    const { rows } = await db.query(
      `SELECT * FROM bills WHERE subscriber_id = $1 AND year = $2 AND month = $3${lock ? " FOR UPDATE" : ""}`,
      [p.subscriberId, p.year, p.month],
    );
    return rows[0] ? toBill(rows[0]) : null;
  }

  getBill(p: Period) {
    return this.bill(this.pool, p, false);
  }

  async upsertBill(b: NewBill) {
    const { rows } = await this.pool.query(
      `INSERT INTO bills (subscriber_id, year, month, phone_minutes, internet_mb, phone_charge, internet_charge,
                          total, paid_amount, status, due_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (subscriber_id, year, month) DO UPDATE SET
         phone_minutes = EXCLUDED.phone_minutes, internet_mb = EXCLUDED.internet_mb,
         phone_charge = EXCLUDED.phone_charge, internet_charge = EXCLUDED.internet_charge,
         total = EXCLUDED.total, paid_amount = EXCLUDED.paid_amount, status = EXCLUDED.status,
         due_date = EXCLUDED.due_date, calculated_at = now()
       RETURNING *`,
      [b.subscriberId, b.year, b.month, b.phoneMinutes, b.internetMb, b.phoneCharge, b.internetCharge,
       b.total, b.paidAmount, b.status, b.dueDate],
    );
    return toBill(rows[0]);
  }

  async transaction<T>(fn: (tx: TxRepository) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx: TxRepository = {
      getBillForUpdate: p => this.bill(client, p, true),
      findPayment: async id => {
        const { rows } = await client.query("SELECT * FROM payments WHERE transaction_id = $1", [id]);
        return rows[0] ? toPayment(rows[0]) : null;
      },
      insertPayment: async (billId, transactionId, amount) => {
        const { rows } = await client.query(
          "INSERT INTO payments (bill_id, transaction_id, amount) VALUES ($1,$2,$3) RETURNING *",
          [billId, transactionId, amount],
        );
        return toPayment(rows[0]);
      },
      updateBillPayment: async (billId: number, paidAmount: number, status: BillStatus) => {
        const { rows } = await client.query(
          "UPDATE bills SET paid_amount = $2, status = $3 WHERE id = $1 RETURNING *",
          [billId, paidAmount, status],
        );
        return toBill(rows[0]);
      },
    };
    try {
      await client.query("BEGIN");
      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  close() {
    return this.pool.end();
  }
}
