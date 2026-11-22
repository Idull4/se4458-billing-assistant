import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateBill, dueDate, internetCharge, phoneCharge, statusFor } from "../src/domain/billing-rules.ts";

test("phone: first 1,000 minutes are free (Guide §2.1)", () => {
  assert.equal(phoneCharge(0), 0);
  assert.equal(phoneCharge(1000), 0);
});

test("phone: each started extra 1,000-minute block costs $10 (Guide §2.2 examples)", () => {
  assert.equal(phoneCharge(1001), 10);
  assert.equal(phoneCharge(2000), 10);
  assert.equal(phoneCharge(2001), 20);
});

test("internet: $50 base even with zero usage, up to 20 GB (Guide §3.1)", () => {
  assert.equal(internetCharge(0), 50);
  assert.equal(internetCharge(20_000), 50);
});

test("internet: each started extra 10 GB block costs $10 (Guide §3.2 examples)", () => {
  assert.equal(internetCharge(20_001), 60); // edge: 1 MB over
  assert.equal(internetCharge(21_000), 60);
  assert.equal(internetCharge(30_000), 60);
  assert.equal(internetCharge(30_001), 70);
  assert.equal(internetCharge(35_000), 70);
});

test("worked example: 1,350 minutes + 35 GB = $80 (Guide §4.3)", () => {
  assert.deepEqual(calculateBill(1350, 35_000), {
    phoneMinutes: 1350, internetMb: 35_000, phoneCharge: 10, internetCharge: 70, total: 80,
  });
});

test("due date is 15 days after the end of the billing month (Guide §6.1)", () => {
  assert.equal(dueDate(2026, 10), "2026-11-15");
  assert.equal(dueDate(2026, 12), "2027-01-15"); // year rollover
  assert.equal(dueDate(2028, 2), "2028-03-15"); // leap year February
});

test("status: partial payment does not mark bill paid (Guide §5.1)", () => {
  assert.equal(statusFor(80, 0), "UNPAID");
  assert.equal(statusFor(80, 30), "PARTIALLY_PAID");
  assert.equal(statusFor(80, 80), "PAID");
});
