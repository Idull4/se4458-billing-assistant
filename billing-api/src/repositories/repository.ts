// Repository (data access) contracts. Implementations: PgRepository (PostgreSQL), MemoryRepository (tests).
import type { BillStatus, UsageType } from "../domain/billing-rules.ts";
import type { Bill, NewBill, Payment, Period, Subscriber, UsageEvent } from "../domain/models.ts";

export type { Bill, NewBill, Payment, Period, Subscriber, UsageEvent };

/** Operations that must run atomically while a bill row is locked (payments). */
export interface TxRepository {
  getBillForUpdate(p: Period): Promise<Bill | null>;
  findPayment(transactionId: string): Promise<Payment | null>;
  insertPayment(billId: number, transactionId: string, amount: number): Promise<Payment>;
  updateBillPayment(billId: number, paidAmount: number, status: BillStatus): Promise<Bill>;
}

export interface Repository {
  findSubscriber(subscriberNo: string): Promise<Subscriber | null>;
  addUsage(p: Period, type: UsageType, quantity: number): Promise<UsageEvent>;
  usageTotals(p: Period): Promise<{ phoneMinutes: number; internetMb: number }>;
  countUsageEvents(p: Period): Promise<number>;
  listUsageEvents(p: Period, offset: number, limit: number): Promise<UsageEvent[]>;
  getBill(p: Period): Promise<Bill | null>;
  /** Insert or update the stored bill (the caller supplies paid amount and status). */
  upsertBill(bill: NewBill): Promise<Bill>;
  transaction<T>(fn: (tx: TxRepository) => Promise<T>): Promise<T>;
}
