// Domain entities (persistence-independent).
import type { BillStatus, UsageType } from "./billing-rules.ts";

export type Role = "subscriber" | "admin";

export interface Subscriber {
  id: number;
  subscriberNo: string;
  name: string;
  passwordHash: string;
  role: Role;
}

export interface Bill {
  id: number;
  subscriberId: number;
  year: number;
  month: number;
  phoneMinutes: number;
  internetMb: number;
  phoneCharge: number;
  internetCharge: number;
  total: number;
  paidAmount: number;
  status: BillStatus;
  dueDate: string;
  calculatedAt: string;
}

export type NewBill = Omit<Bill, "id" | "calculatedAt">;

export interface UsageEvent {
  id: number;
  usageType: UsageType;
  quantity: number;
  createdAt: string;
}

export interface Payment {
  id: number;
  billId: number;
  transactionId: string;
  amount: number;
  createdAt: string;
}

/** A subscriber's billing period. */
export interface Period {
  subscriberId: number;
  year: number;
  month: number;
}

/** Authenticated caller (from the JWT). */
export interface Principal {
  subscriberNo: string;
  role: Role;
}
