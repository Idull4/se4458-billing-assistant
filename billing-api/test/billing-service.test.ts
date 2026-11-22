// Service-layer tests: business logic called directly, without HTTP (shows the layers are independent).
import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryRepository } from "../src/repositories/memory-repository.ts";
import { BillingService } from "../src/services/billing-service.ts";
import { ApiError } from "../src/shared/api-error.ts";

function fresh() {
  const repo = new MemoryRepository();
  repo.addSubscriber({ subscriberNo: "5551001", name: "A", passwordHash: "x", role: "subscriber" });
  repo.addSubscriber({ subscriberNo: "admin", name: "Admin", passwordHash: "x", role: "admin" });
  return { repo, service: new BillingService(repo) };
}

test("addUsage records 10 minutes per PHONE event and 1 MB per INTERNET event", async () => {
  const { service } = fresh();
  await service.addUsage({ subscriberNo: "5551001", year: 2026, month: 10, usageType: "PHONE" });
  const r = await service.addUsage({ subscriberNo: "5551001", year: 2026, month: 10, usageType: "INTERNET" });
  assert.deepEqual(r.periodTotals, { phoneMinutes: 10, internetMb: 1 });
});

test("calculate with no usage produces the $50 internet base bill", async () => {
  const { service } = fresh();
  const r = await service.calculate({ subscriberNo: "5551001", year: 2026, month: 10 });
  assert.equal(r.bill.total, 50);
  assert.equal(r.recalculated, false);
});

test("admin accounts are not billable subscribers (404)", async () => {
  const { service } = fresh();
  await assert.rejects(service.queryBill({ subscriberNo: "admin", year: 2026, month: 10 }),
    (e: ApiError) => e.status === 404 && e.code === "SUBSCRIBER_NOT_FOUND");
});

test("pay rejects duplicates before touching the balance", async () => {
  const { service, repo } = fresh();
  await service.calculate({ subscriberNo: "5551001", year: 2026, month: 10 });
  await service.pay({ subscriberNo: "5551001", year: 2026, month: 10, amount: 20, transactionId: "TXN-svc-1" });
  await assert.rejects(service.pay({ subscriberNo: "5551001", year: 2026, month: 10, amount: 20, transactionId: "TXN-svc-1" }),
    (e: ApiError) => e.status === 409);
  assert.equal(repo.bills[0].paidAmount, 20);
});
