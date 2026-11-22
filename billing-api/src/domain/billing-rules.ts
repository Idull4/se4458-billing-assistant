// Pure billing rules from Mobile_Provider_Billing_Guide.md (sections 2-6).

export const PHONE_MINUTES_PER_EVENT = 10; // §2.3
export const INTERNET_MB_PER_EVENT = 1; // §3.3
export const MB_PER_GB = 1000; // §3.3

export type UsageType = "PHONE" | "INTERNET";
export type BillStatus = "UNPAID" | "PARTIALLY_PAID" | "PAID";

export function quantityFor(type: UsageType): number {
  return type === "PHONE" ? PHONE_MINUTES_PER_EVENT : INTERNET_MB_PER_EVENT;
}

/** §2.1-2.2, §4.2: first 1,000 minutes free, then $10 per started 1,000-minute block. */
export function phoneCharge(minutes: number): number {
  return 10 * Math.ceil(Math.max(0, minutes - 1000) / 1000);
}

/** §3.1-3.2, §4.2: $50 up to 20 GB (even with zero usage), then $10 per started 10 GB block. */
export function internetCharge(megabytes: number): number {
  // Integer MB arithmetic avoids floating point errors (20,001 MB = 20.001 GB -> one extra block).
  const extraMb = Math.max(0, megabytes - 20 * MB_PER_GB);
  return 50 + 10 * Math.ceil(extraMb / (10 * MB_PER_GB));
}

export interface BillBreakdown {
  phoneMinutes: number;
  internetMb: number;
  phoneCharge: number;
  internetCharge: number;
  total: number;
}

export function calculateBill(phoneMinutes: number, internetMb: number): BillBreakdown {
  const phone = phoneCharge(phoneMinutes);
  const internet = internetCharge(internetMb);
  return { phoneMinutes, internetMb, phoneCharge: phone, internetCharge: internet, total: phone + internet };
}

/** §6.1: due 15 calendar days after the end of the billing month (ISO date, UTC). */
export function dueDate(year: number, month: number): string {
  const endOfMonth = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last day of this month
  endOfMonth.setUTCDate(endOfMonth.getUTCDate() + 15);
  return endOfMonth.toISOString().slice(0, 10);
}

/** §5.1: partial payments reduce the balance but only a zero balance means PAID. */
export function statusFor(total: number, paid: number): BillStatus {
  if (paid <= 0) return total <= 0 ? "PAID" : "UNPAID";
  return paid >= total ? "PAID" : "PARTIALLY_PAID";
}

/** Money helper: round to cents to avoid float drift. */
export function money(value: number): number {
  return Math.round(value * 100) / 100;
}
