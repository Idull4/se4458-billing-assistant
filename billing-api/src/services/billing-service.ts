// Service layer: billing business logic, independent of HTTP (controllers) and storage (repositories).
import { calculateBill, dueDate, money, quantityFor, statusFor, type UsageType } from "../domain/billing-rules.ts";
import type { Subscriber } from "../domain/models.ts";
import { toBillDto, toBreakdownDto, toPageDto, toUsageDto } from "../dto/bill-dto.ts";
import type { Repository } from "../repositories/repository.ts";
import { ApiError } from "../shared/api-error.ts";

export interface PeriodInput {
  subscriberNo: string;
  year: number;
  month: number;
}

export class BillingService {
  repo: Repository;

  constructor(repo: Repository) {
    this.repo = repo;
  }

  async subscriber(subscriberNo: string): Promise<Subscriber> {
    const s = await this.repo.findSubscriber(subscriberNo);
    if (!s || s.role !== "subscriber") {
      throw new ApiError(404, "SUBSCRIBER_NOT_FOUND", `Subscriber ${subscriberNo} was not found.`);
    }
    return s;
  }

  private async storedBill(input: PeriodInput) {
    const s = await this.subscriber(input.subscriberNo);
    const bill = await this.repo.getBill({ subscriberId: s.id, year: input.year, month: input.month });
    if (!bill) {
      // Guide §4.4: never present an estimate as a stored bill.
      throw new ApiError(404, "BILL_NOT_FOUND",
        `No calculated bill exists for subscriber ${input.subscriberNo} for ${input.month}/${input.year}. Run Calculate Bill first.`);
    }
    return { s, bill };
  }

  /** Add Usage: one call = 10 phone minutes or 1 MB internet. */
  async addUsage(input: PeriodInput & { usageType: UsageType }) {
    const s = await this.subscriber(input.subscriberNo);
    const period = { subscriberId: s.id, year: input.year, month: input.month };
    const quantity = quantityFor(input.usageType);
    await this.repo.addUsage(period, input.usageType, quantity);
    const totals = await this.repo.usageTotals(period);
    return {
      status: "SUCCESS",
      subscriberNo: s.subscriberNo,
      month: input.month,
      year: input.year,
      usageType: input.usageType,
      added: input.usageType === "PHONE" ? { minutes: quantity } : { megabytes: quantity },
      periodTotals: totals,
    };
  }

  /** Calculate Bill: compute from recorded usage and store (upsert, keeps payments). */
  async calculate(input: PeriodInput) {
    const s = await this.subscriber(input.subscriberNo);
    const period = { subscriberId: s.id, year: input.year, month: input.month };
    const totals = await this.repo.usageTotals(period);
    const calc = calculateBill(totals.phoneMinutes, totals.internetMb);
    const existing = await this.repo.getBill(period);
    const paidAmount = existing?.paidAmount ?? 0;
    const bill = await this.repo.upsertBill({
      ...period,
      ...calc,
      paidAmount,
      status: statusFor(calc.total, paidAmount),
      dueDate: dueDate(input.year, input.month),
    });
    return { status: "SUCCESS", recalculated: Boolean(existing), bill: { ...toBillDto(s.subscriberNo, bill), breakdown: toBreakdownDto(bill) } };
  }

  async queryBill(input: PeriodInput) {
    const { s, bill } = await this.storedBill(input);
    return toBillDto(s.subscriberNo, bill);
  }

  async queryBillDetailed(input: PeriodInput & { page: number; pageSize: number }) {
    const { s, bill } = await this.storedBill(input);
    const period = { subscriberId: s.id, year: input.year, month: input.month };
    const totalItems = await this.repo.countUsageEvents(period);
    const items = await this.repo.listUsageEvents(period, (input.page - 1) * input.pageSize, input.pageSize);
    return {
      ...toBillDto(s.subscriberNo, bill),
      usage: toUsageDto(bill),
      breakdown: toBreakdownDto(bill),
      usageEvents: toPageDto(items, input.page, input.pageSize, totalItems),
    };
  }

  /** Pay Bill: simulated partial/full payment with duplicate and over-payment protection. */
  async pay(input: PeriodInput & { amount: number; transactionId: string }) {
    const s = await this.subscriber(input.subscriberNo);
    const period = { subscriberId: s.id, year: input.year, month: input.month };
    const amount = money(input.amount);
    try {
      return await this.repo.transaction(async tx => {
        const previous = await tx.findPayment(input.transactionId);
        if (previous) {
          throw new ApiError(409, "DUPLICATE_TRANSACTION",
            `Transaction ${input.transactionId} was already processed; no new payment was recorded.`,
            { originalPayment: { amount: previous.amount, recordedAt: previous.createdAt } });
        }
        const bill = await tx.getBillForUpdate(period);
        if (!bill) {
          throw new ApiError(404, "BILL_NOT_FOUND", `No calculated bill exists for ${input.month}/${input.year}.`);
        }
        const remaining = money(bill.total - bill.paidAmount);
        if (remaining <= 0) {
          throw new ApiError(422, "BILL_ALREADY_PAID", "This bill is already fully paid.");
        }
        if (amount > remaining) {
          throw new ApiError(422, "AMOUNT_EXCEEDS_BALANCE",
            `Payment amount ${amount} exceeds the remaining balance ${remaining}.`, { remainingBalance: remaining });
        }
        await tx.insertPayment(bill.id, input.transactionId, amount);
        const paid = money(bill.paidAmount + amount);
        const updated = await tx.updateBillPayment(bill.id, paid, statusFor(bill.total, paid));
        return {
          paymentStatus: "SUCCESS",
          transactionId: input.transactionId,
          paymentAmount: amount,
          ...toBillDto(s.subscriberNo, updated), // paidAmount = total paid so far
        };
      });
    } catch (error: any) {
      // Concurrent duplicate caught by the UNIQUE constraint.
      if (error?.code === "23505") {
        throw new ApiError(409, "DUPLICATE_TRANSACTION", `Transaction ${input.transactionId} was already processed.`);
      }
      throw error;
    }
  }
}

