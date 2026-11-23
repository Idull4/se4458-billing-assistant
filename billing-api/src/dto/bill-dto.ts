// Response DTOs: map domain entities to the public API representation.
import { money } from "../domain/billing-rules.ts";
import type { Bill, UsageEvent } from "../domain/models.ts";

export interface BillDto {
  subscriberNo: string;
  month: number;
  year: number;
  currency: "USD";
  total: number;
  paidAmount: number;
  remainingBalance: number;
  status: Bill["status"];
  dueDate: string;
  calculatedAt: string;
}

export function toBillDto(subscriberNo: string, b: Bill): BillDto {
  return {
    subscriberNo,
    month: b.month,
    year: b.year,
    currency: "USD",
    total: b.total,
    paidAmount: b.paidAmount,
    remainingBalance: money(b.total - b.paidAmount),
    status: b.status,
    dueDate: b.dueDate,
    calculatedAt: b.calculatedAt,
  };
}

/**
 * Charge breakdown = data only (usage and the stored charges). Pricing policy is deliberately NOT
 * repeated here: per Billing Guide §9 the assistant explains rules from the MCP documentation index.
 */
export function toBreakdownDto(b: Bill) {
  return {
    phone: { minutes: b.phoneMinutes, charge: b.phoneCharge },
    internet: { megabytes: b.internetMb, gigabytes: b.internetMb / 1000, charge: b.internetCharge },
    total: b.total,
  };
}

export function toUsageDto(b: Bill) {
  return { phoneMinutes: b.phoneMinutes, internetMb: b.internetMb, internetGb: b.internetMb / 1000 };
}

export function toPageDto(items: UsageEvent[], page: number, pageSize: number, totalItems: number) {
  return { page, pageSize, totalItems, totalPages: Math.max(1, Math.ceil(totalItems / pageSize)), items };
}
