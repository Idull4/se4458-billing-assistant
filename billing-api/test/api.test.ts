// API tests: real HTTP layer (supertest) + business logic, in-memory repository (no DB, no cloud, no LLM).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { ADMIN, PASSWORD, SUB1, SUB2, setup, token } from "./helpers.ts";

describe("POST /api/v1/auth/login", () => {
  test("returns a JWT for valid credentials", async () => {
    const { http } = await setup();
    const res = await http.post("/api/v1/auth/login").send({ subscriberNo: "5551001", password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.tokenType, "Bearer");
    assert.equal(res.body.role, "subscriber");
    assert.ok(res.body.accessToken.split(".").length === 3);
  });

  test("rejects a wrong password with 401", async () => {
    const { http } = await setup();
    const res = await http.post("/api/v1/auth/login").send({ subscriberNo: "5551001", password: "nope" });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, "INVALID_CREDENTIALS");
  });
});

describe("POST /api/v1/usage (Add Usage)", () => {
  test("PHONE adds 10 minutes and INTERNET adds 1 MB", async () => {
    const { http } = await setup();
    const phone = await http.post("/api/v1/usage").set("Authorization", ADMIN())
      .send({ subscriberNo: "5551002", month: 11, year: 2026, usageType: "PHONE" });
    assert.equal(phone.status, 201);
    assert.deepEqual(phone.body.added, { minutes: 10 });
    const net = await http.post("/api/v1/usage").set("Authorization", ADMIN())
      .send({ subscriberNo: "5551002", month: 11, year: 2026, usageType: "INTERNET" });
    assert.deepEqual(net.body.periodTotals, { phoneMinutes: 10, internetMb: 1 });
  });

  test("rejects an invalid usage type with 400", async () => {
    const { http } = await setup();
    const res = await http.post("/api/v1/usage").set("Authorization", ADMIN())
      .send({ subscriberNo: "5551002", month: 11, year: 2026, usageType: "SMS" });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
  });

  test("requires authentication (401) and admin role (403)", async () => {
    const { http } = await setup();
    const body = { subscriberNo: "5551001", month: 11, year: 2026, usageType: "PHONE" };
    assert.equal((await http.post("/api/v1/usage").send(body)).status, 401);
    assert.equal((await http.post("/api/v1/usage").set("Authorization", SUB1()).send(body)).status, 403);
  });

  test("returns 404 for an unknown subscriber", async () => {
    const { http } = await setup();
    const res = await http.post("/api/v1/usage").set("Authorization", ADMIN())
      .send({ subscriberNo: "9999999", month: 11, year: 2026, usageType: "PHONE" });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "SUBSCRIBER_NOT_FOUND");
  });
});

describe("POST /api/v1/bills/calculate (Calculate Bill)", () => {
  test("calculates and stores the bill from recorded usage", async () => {
    const { http } = await setup();
    for (let i = 0; i < 101; i++) {
      await http.post("/api/v1/usage").set("Authorization", ADMIN())
        .send({ subscriberNo: "5551002", month: 11, year: 2026, usageType: "PHONE" });
    }
    const res = await http.post("/api/v1/bills/calculate").set("Authorization", ADMIN())
      .send({ subscriberNo: "5551002", month: 11, year: 2026 });
    assert.equal(res.status, 200);
    assert.equal(res.body.bill.breakdown.phone.minutes, 1010);
    assert.equal(res.body.bill.breakdown.phone.charge, 10); // 1,010 min -> one extra block
    assert.equal(res.body.bill.breakdown.internet.charge, 50); // zero internet still $50
    assert.equal(res.body.bill.total, 60);
    assert.equal(res.body.bill.status, "UNPAID");
    assert.equal(res.body.bill.dueDate, "2026-12-15");
  });

  test("recalculation keeps payments already made", async () => {
    const { http } = await setup();
    await http.post("/api/v1/bills/pay").set("Authorization", SUB1()).send({ month: 10, year: 2026, amount: 30, transactionId: "TXN-recalc-1" });
    const res = await http.post("/api/v1/bills/calculate").set("Authorization", ADMIN())
      .send({ subscriberNo: "5551001", month: 10, year: 2026 });
    assert.equal(res.body.recalculated, true);
    assert.equal(res.body.bill.paidAmount, 30);
    assert.equal(res.body.bill.remainingBalance, 50);
    assert.equal(res.body.bill.status, "PARTIALLY_PAID");
  });

  test("rejects an invalid month with 400", async () => {
    const { http } = await setup();
    const res = await http.post("/api/v1/bills/calculate").set("Authorization", ADMIN())
      .send({ subscriberNo: "5551001", month: 13, year: 2026 });
    assert.equal(res.status, 400);
  });

  test("subscribers cannot calculate bills (403)", async () => {
    const { http } = await setup();
    const res = await http.post("/api/v1/bills/calculate").set("Authorization", SUB1())
      .send({ subscriberNo: "5551001", month: 10, year: 2026 });
    assert.equal(res.status, 403);
  });
});

describe("GET /api/v1/bills (Query Bill)", () => {
  test("returns the stored bill without authentication", async () => {
    const { http } = await setup();
    const res = await http.get("/api/v1/bills").query({ subscriberNo: "5551001", month: 10, year: 2026 });
    assert.equal(res.status, 200);
    assert.equal(res.body.total, 80);
    assert.equal(res.body.paidAmount, 0);
    assert.equal(res.body.remainingBalance, 80);
    assert.equal(res.body.status, "UNPAID");
    assert.equal(res.body.dueDate, "2026-11-15");
  });

  test("returns 404 BILL_NOT_FOUND when the bill has not been calculated (Guide §4.4)", async () => {
    const { http } = await setup();
    const res = await http.get("/api/v1/bills").query({ subscriberNo: "5551001", month: 11, year: 2026 });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "BILL_NOT_FOUND");
  });

  test("rejects missing parameters with 400", async () => {
    const { http } = await setup();
    const res = await http.get("/api/v1/bills").query({ month: 10, year: 2026 });
    assert.equal(res.status, 400);
  });
});

describe("GET /api/v1/bills/detailed (Query Bill Detailed)", () => {
  test("returns breakdown and paged usage events for the token's subscriber", async () => {
    const { http } = await setup();
    const res = await http.get("/api/v1/bills/detailed").set("Authorization", SUB1())
      .query({ month: 10, year: 2026, page: 2, pageSize: 50 });
    assert.equal(res.status, 200);
    assert.equal(res.body.subscriberNo, "5551001");
    assert.deepEqual(res.body.usage, { phoneMinutes: 1350, internetMb: 35_000, internetGb: 35 });
    assert.equal(res.body.breakdown.phone.charge, 10);
    assert.equal(res.body.breakdown.internet.charge, 70);
    assert.equal(res.body.usageEvents.totalItems, 136);
    assert.equal(res.body.usageEvents.totalPages, 3);
    assert.equal(res.body.usageEvents.page, 2);
    assert.equal(res.body.usageEvents.items.length, 50);
  });

  test("a subscriber cannot read another subscriber's bill (403)", async () => {
    const { http } = await setup();
    const res = await http.get("/api/v1/bills/detailed").set("Authorization", SUB2())
      .query({ subscriberNo: "5551001", month: 10, year: 2026 });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, "FORBIDDEN");
  });

  test("requires authentication (401) and rejects expired or forged tokens", async () => {
    const { http } = await setup();
    const q = { month: 10, year: 2026 };
    assert.equal((await http.get("/api/v1/bills/detailed").query(q)).status, 401);
    const forged = token("5551001", "subscriber", "wrong-secret");
    assert.equal((await http.get("/api/v1/bills/detailed").set("Authorization", `Bearer ${forged}`).query(q)).status, 401);
    const expired = token("5551001", "subscriber", undefined, -10);
    assert.equal((await http.get("/api/v1/bills/detailed").set("Authorization", `Bearer ${expired}`).query(q)).status, 401);
  });

  test("rejects pageSize above 100 with 400", async () => {
    const { http } = await setup();
    const res = await http.get("/api/v1/bills/detailed").set("Authorization", SUB1())
      .query({ month: 10, year: 2026, pageSize: 500 });
    assert.equal(res.status, 400);
  });

  test("admin can read any subscriber's detailed bill", async () => {
    const { http } = await setup();
    const res = await http.get("/api/v1/bills/detailed").set("Authorization", ADMIN())
      .query({ subscriberNo: "5551001", month: 10, year: 2026 });
    assert.equal(res.status, 200);
    assert.equal(res.body.usageEvents.pageSize, 20);
  });
});

describe("POST /api/v1/bills/pay (Pay Bill)", () => {
  test("partial payment reduces the balance but keeps the bill unpaid (Guide §5.1)", async () => {
    const { http } = await setup();
    const res = await http.post("/api/v1/bills/pay").set("Authorization", SUB1())
      .send({ month: 10, year: 2026, amount: 30, transactionId: "TXN-partial-1" });
    assert.equal(res.status, 200);
    assert.equal(res.body.paymentStatus, "SUCCESS");
    assert.equal(res.body.paymentAmount, 30);
    assert.equal(res.body.paidAmount, 30);
    assert.equal(res.body.remainingBalance, 50);
    assert.equal(res.body.status, "PARTIALLY_PAID");
  });

  test("paying the remaining balance marks the bill PAID; further payments are rejected", async () => {
    const { http } = await setup();
    await http.post("/api/v1/bills/pay").set("Authorization", SUB1()).send({ month: 10, year: 2026, amount: 30.5, transactionId: "TXN-full-1" });
    const res = await http.post("/api/v1/bills/pay").set("Authorization", SUB1()).send({ month: 10, year: 2026, amount: 49.5, transactionId: "TXN-full-2" });
    assert.equal(res.body.status, "PAID");
    assert.equal(res.body.paymentAmount, 49.5);
    assert.equal(res.body.paidAmount, 80); // cumulative
    assert.equal(res.body.remainingBalance, 0);
    const again = await http.post("/api/v1/bills/pay").set("Authorization", SUB1()).send({ month: 10, year: 2026, amount: 1, transactionId: "TXN-full-3" });
    assert.equal(again.status, 422);
    assert.equal(again.body.error.code, "BILL_ALREADY_PAID");
  });

  test("rejects a duplicate transaction ID with 409 and records no second payment", async () => {
    const { http, repo } = await setup();
    const body = { month: 10, year: 2026, amount: 10, transactionId: "TXN-dup-1" };
    assert.equal((await http.post("/api/v1/bills/pay").set("Authorization", SUB1()).send(body)).status, 200);
    const dup = await http.post("/api/v1/bills/pay").set("Authorization", SUB1()).send(body);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, "DUPLICATE_TRANSACTION");
    assert.equal(dup.body.error.details.originalPayment.amount, 10);
    assert.equal(repo.payments.length, 1);
    const bill = await http.get("/api/v1/bills").query({ subscriberNo: "5551001", month: 10, year: 2026 });
    assert.equal(bill.body.paidAmount, 10);
  });

  test("concurrent duplicate requests record only one payment", async () => {
    const { http, repo } = await setup();
    const body = { month: 10, year: 2026, amount: 10, transactionId: "TXN-race-1" };
    const results = await Promise.all([1, 2, 3].map(() => http.post("/api/v1/bills/pay").set("Authorization", SUB1()).send(body)));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409]);
    assert.equal(repo.payments.length, 1);
  });

  test("rejects an amount above the remaining balance with 422", async () => {
    const { http } = await setup();
    const res = await http.post("/api/v1/bills/pay").set("Authorization", SUB1())
      .send({ month: 10, year: 2026, amount: 80.01, transactionId: "TXN-over-1" });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, "AMOUNT_EXCEEDS_BALANCE");
    assert.equal(res.body.error.details.remainingBalance, 80);
  });

  test("rejects zero, negative and non-numeric amounts with 400", async () => {
    const { http } = await setup();
    for (const amount of [0, -5, "10", 1.234]) {
      const res = await http.post("/api/v1/bills/pay").set("Authorization", SUB1())
        .send({ month: 10, year: 2026, amount, transactionId: "TXN-bad-1" });
      assert.equal(res.status, 400, `amount ${amount}`);
    }
  });

  test("cannot pay another subscriber's bill (403) or without a token (401)", async () => {
    const { http } = await setup();
    const body = { subscriberNo: "5551001", month: 10, year: 2026, amount: 10, transactionId: "TXN-other-1" };
    assert.equal((await http.post("/api/v1/bills/pay").set("Authorization", SUB2()).send(body)).status, 403);
    assert.equal((await http.post("/api/v1/bills/pay").send(body)).status, 401);
  });

  test("returns 404 when paying a bill that was not calculated", async () => {
    const { http } = await setup();
    const res = await http.post("/api/v1/bills/pay").set("Authorization", SUB1())
      .send({ month: 11, year: 2026, amount: 10, transactionId: "TXN-nobill-1" });
    assert.equal(res.status, 404);
  });
});

describe("Cross-cutting", () => {
  test("unknown routes return a JSON 404 error", async () => {
    const { http } = await setup();
    const res = await http.get("/api/v2/bills");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "NOT_FOUND");
  });

  test("Swagger/OpenAPI document is served", async () => {
    const { http } = await setup();
    const res = await http.get("/api/v1/openapi.json");
    assert.equal(res.status, 200);
    assert.ok(res.body.paths["/api/v1/bills/pay"]);
  });
});
