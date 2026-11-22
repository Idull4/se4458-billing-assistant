// In-memory repository used by unit tests (no database required).
import type { BillStatus, UsageType } from "../domain/billing-rules.ts";
import type { Bill, NewBill, Payment, Period, Repository, Subscriber, TxRepository, UsageEvent } from "./repository.ts";

interface StoredEvent extends UsageEvent, Period {}

export class MemoryRepository implements Repository {
  subscribers: Subscriber[] = [];
  events: StoredEvent[] = [];
  bills: Bill[] = [];
  payments: Payment[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 1;

  addSubscriber(s: Omit<Subscriber, "id">): Subscriber {
    const sub = { ...s, id: this.seq++ };
    this.subscribers.push(sub);
    return sub;
  }

  private same = (a: Period, b: Period) =>
    a.subscriberId === b.subscriberId && a.year === b.year && a.month === b.month;

  async findSubscriber(subscriberNo: string) {
    return this.subscribers.find(s => s.subscriberNo === subscriberNo) ?? null;
  }

  async addUsage(p: Period, usageType: UsageType, quantity: number) {
    const event: StoredEvent = { ...p, id: this.seq++, usageType, quantity, createdAt: new Date(Date.now() + this.seq).toISOString() };
    this.events.push(event);
    return { id: event.id, usageType, quantity, createdAt: event.createdAt };
  }

  async usageTotals(p: Period) {
    let phoneMinutes = 0, internetMb = 0;
    for (const e of this.events) {
      if (!this.same(e, p)) continue;
      if (e.usageType === "PHONE") phoneMinutes += e.quantity; else internetMb += e.quantity;
    }
    return { phoneMinutes, internetMb };
  }

  async countUsageEvents(p: Period) {
    return this.events.filter(e => this.same(e, p)).length;
  }

  async listUsageEvents(p: Period, offset: number, limit: number) {
    return this.events
      .filter(e => this.same(e, p))
      .sort((a, b) => b.id - a.id)
      .slice(offset, offset + limit)
      .map(({ id, usageType, quantity, createdAt }) => ({ id, usageType, quantity, createdAt }));
  }

  async getBill(p: Period) {
    const bill = this.bills.find(b => this.same(b, p));
    return bill ? { ...bill } : null;
  }

  async upsertBill(nb: NewBill) {
    const now = new Date().toISOString();
    const existing = this.bills.find(b => this.same(b, nb));
    if (existing) {
      Object.assign(existing, nb, { calculatedAt: now });
      return { ...existing };
    }
    const bill: Bill = { ...nb, id: this.seq++, calculatedAt: now };
    this.bills.push(bill);
    return { ...bill };
  }

  // Serialise transactions to mimic row locking.
  transaction<T>(fn: (tx: TxRepository) => Promise<T>): Promise<T> {
    const tx: TxRepository = {
      getBillForUpdate: async p => this.getBill(p),
      findPayment: async id => this.payments.find(x => x.transactionId === id) ?? null,
      insertPayment: async (billId, transactionId, amount) => {
        const payment = { id: this.seq++, billId, transactionId, amount, createdAt: new Date().toISOString() };
        this.payments.push(payment);
        return payment;
      },
      updateBillPayment: async (billId: number, paidAmount: number, status: BillStatus) => {
        const bill = this.bills.find(b => b.id === billId)!;
        bill.paidAmount = paidAmount;
        bill.status = status;
        return { ...bill };
      },
    };
    const run = this.queue.then(() => fn(tx));
    this.queue = run.catch(() => undefined);
    return run;
  }
}
