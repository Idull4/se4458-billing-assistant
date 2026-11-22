// Request validation: turns raw query/body input into typed, validated service inputs.
import type { UsageType } from "../domain/billing-rules.ts";
import { badRequest } from "../shared/api-error.ts";

type Input = Record<string, unknown>;

const SUBSCRIBER_NO = /^[A-Za-z0-9-]{3,20}$/;
const TRANSACTION_ID = /^[A-Za-z0-9_.:-]{6,64}$/;

export function int(value: unknown, field: string, min: number, max: number): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw badRequest(`'${field}' must be an integer between ${min} and ${max}.`, { field });
  }
  return n;
}

export function subscriberNo(value: unknown, field = "subscriberNo"): string {
  if (typeof value !== "string" || !SUBSCRIBER_NO.test(value)) {
    throw badRequest(`'${field}' is required (3-20 letters, digits or '-').`, { field });
  }
  return value;
}

export function period(src: Input) {
  return { month: int(src.month, "month", 1, 12), year: int(src.year, "year", 2000, 2100) };
}

export function amount(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw badRequest("'amount' must be a positive number.", { field: "amount" });
  }
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) {
    throw badRequest("'amount' can have at most 2 decimal places.", { field: "amount" });
  }
  return value;
}

export function transactionId(value: unknown): string {
  if (typeof value !== "string" || !TRANSACTION_ID.test(value)) {
    throw badRequest("'transactionId' is required (6-64 characters: letters, digits, _ . : -).", { field: "transactionId" });
  }
  return value;
}

export function usageType(value: unknown): UsageType {
  if (value !== "PHONE" && value !== "INTERNET") {
    throw badRequest("'usageType' must be PHONE or INTERNET.", { field: "usageType" });
  }
  return value;
}

export function paging(src: Input) {
  return {
    page: src.page === undefined ? 1 : int(src.page, "page", 1, 1_000_000),
    pageSize: src.pageSize === undefined ? 20 : int(src.pageSize, "pageSize", 1, 100),
  };
}

// ---- per-endpoint request validators ----

export function loginRequest(body: Input) {
  const { subscriberNo: user, password } = body;
  if (typeof user !== "string" || typeof password !== "string" || !user || !password) {
    throw badRequest("'subscriberNo' and 'password' are required.");
  }
  return { subscriberNo: user, password };
}

export function addUsageRequest(body: Input) {
  return { subscriberNo: subscriberNo(body.subscriberNo), ...period(body), usageType: usageType(body.usageType) };
}

export function periodRequest(src: Input) {
  return { subscriberNo: subscriberNo(src.subscriberNo), ...period(src) };
}

/** subscriberNo is resolved separately (from the token or, for admins, from the request). */
export function detailedRequest(query: Input) {
  return { ...period(query), ...paging(query) };
}

export function payRequest(body: Input) {
  return { ...period(body), amount: amount(body.amount), transactionId: transactionId(body.transactionId) };
}
