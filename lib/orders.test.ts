import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, getFarmerRecord, listOrders, type Actor } from "./access";
import { approveOrder, getReview } from "./approval";
import { planOrder, PlanError } from "./money";
import { createDemoOrder, createOrder, nextOrderRef, planFromRequest } from "./orders";
import { verifyPayees } from "./payees";
import { PaymentError } from "./payments";
import { authorizePayouts, handlePayoutCallback, startPayouts } from "./payouts";
import { approvedQuery, makeWorld, verifyAndApprove, type World } from "./test-world";

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const actorOf = (username: string): Actor => {
  const u = w.db.prepare("SELECT id, role, name, linked_farmer_id FROM users WHERE username = ?").get(username) as { id: number; role: Actor["role"]; name: string; linked_farmer_id: string | null };
  return { id: u.id, role: u.role, name: u.name, linkedFarmerId: u.linked_farmer_id };
};
const workedLines = [
  { farmerId: "farmer-a", produce: "Tomatoes", kg: 20, priceMinorPerKg: 200 },
  { farmerId: "farmer-b", produce: "Peppers", kg: 10, priceMinorPerKg: 350 },
  { farmerId: "farmer-c", produce: "Okra", kg: 10, priceMinorPerKg: 250 },
];
const workedTerms = { "farmer-a": { feeMinor: 200, deductionMinor: 100 }, "farmer-b": { feeMinor: 200, deductionMinor: 100 }, "farmer-c": { feeMinor: 100, deductionMinor: 100 } };
const body = (over: Record<string, unknown> = {}) => ({
  buyerUserId: actorOf("buyer").id,
  lines: [
    { farmerId: "farmer-a", produce: "Tomatoes", kg: "20", price: "2.00" },
    { farmerId: "farmer-b", produce: "Peppers", kg: 10, price: "3.50" },
    { farmerId: "farmer-c", produce: "Okra", kg: "10", price: "2.5" },
  ],
  terms: { "farmer-a": { fee: "200", deduction: "100" }, "farmer-b": { fee: 200, deduction: 100 }, "farmer-c": { fee: "100", deduction: "100" } },
  ...over,
});

describe("planOrder (money engine)", () => {
  it("reproduces the worked example from lines and per-farmer terms", () => {
    const p = planOrder(workedLines, workedTerms);
    expect(p.expectedReceiveMinor).toBe(10000);
    expect(p.farmers.map((f) => [f.farmerId, f.grossMinor, f.feeMinor, f.deductionMinor, f.netMinor])).toEqual([
      ["farmer-a", 4000, 200, 100, 3700], ["farmer-b", 3500, 200, 100, 3200], ["farmer-c", 2500, 100, 100, 2300],
    ]);
    expect([p.logisticsMinor, p.retainedMinor, p.ledger.farmerNetsMinor, p.ledger.totalMinor]).toEqual([300, 500, 9200, 10000]);
  });

  it("fee and deduction are per farmer, applied once even with several lines", () => {
    const p = planOrder([...workedLines, { farmerId: "farmer-a", produce: "Onions", kg: 5, priceMinorPerKg: 100 }], workedTerms);
    const a = p.farmers.find((f) => f.farmerId === "farmer-a")!;
    expect([a.grossMinor, a.feeMinor, a.deductionMinor, a.netMinor]).toEqual([4500, 200, 100, 4200]);
    expect(p.ledger.totalMinor).toBe(p.expectedReceiveMinor);
  });

  it.each([
    ["zero kg", { kg: 0 }, /whole number/],
    ["fractional kg", { kg: 1.5 }, /whole number/],
    ["negative kg", { kg: -3 }, /whole number/],
    ["zero price", { priceMinorPerKg: 0 }, /above zero/],
    ["negative price", { priceMinorPerKg: -5 }, /above zero/],
    ["fractional price", { priceMinorPerKg: 2.5 }, /above zero/],
    ["empty produce name", { produce: "  " }, /produce name/],
  ])("rejects %s", (_n, patch, msg) => {
    expect(() => planOrder([{ ...workedLines[0], ...patch }], workedTerms)).toThrow(PlanError);
    expect(() => planOrder([{ ...workedLines[0], ...patch }], workedTerms)).toThrow(msg);
  });

  it("rejects negative fee or deduction, and anything that makes a net negative or zero", () => {
    expect(() => planOrder([workedLines[0]], { "farmer-a": { feeMinor: -1, deductionMinor: 100 } })).toThrow(/zero or more/);
    expect(() => planOrder([workedLines[0]], { "farmer-a": { feeMinor: 100, deductionMinor: -1 } })).toThrow(/zero or more/);
    expect(() => planOrder([workedLines[0]], { "farmer-a": { feeMinor: 3000, deductionMinor: 1500 } })).toThrow(/negative/);
    expect(() => planOrder([workedLines[0]], { "farmer-a": { feeMinor: 3900, deductionMinor: 100 } })).toThrow(/zero/);
    expect(() => planOrder([], {})).toThrow(/at least one/);
    expect(() => planOrder([workedLines[0]], {})).toThrow(/missing/);
  });

  it("collects every problem at once", () => {
    try {
      planOrder([{ farmerId: "farmer-a", produce: "", kg: 0, priceMinorPerKg: 0 }], workedTerms);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as PlanError).errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("Create order", () => {
  it("converts decimal prices to integer minor units and validates the request", () => {
    const r = planFromRequest(w.db, body());
    expect(r.ok && r.plan.expectedReceiveMinor).toBe(10000);
    for (const bad of ["3.555", "abc", "-1", ""]) {
      const x = planFromRequest(w.db, body({ lines: [{ farmerId: "farmer-a", produce: "T", kg: 1, price: bad }] }));
      expect(x.ok, bad).toBe(false);
    }
    expect(planFromRequest(w.db, body({ buyerUserId: 9999 })).ok).toBe(false);
    expect(planFromRequest(w.db, body({ lines: [{ farmerId: "farmer-zzz", produce: "T", kg: 1, price: "1.00" }] })).ok).toBe(false);
    expect(planFromRequest(w.db, body({ terms: { "farmer-a": { fee: "-5", deduction: "1" }, "farmer-b": { fee: "1", deduction: "1" }, "farmer-c": { fee: "1", deduction: "1" } } })).ok).toBe(false);
    expect(planFromRequest(w.db, null as never).ok).toBe(false);
  });

  it("creates PO-0125 as AWAITING_PAYMENT with UNAPPROVED allocations; references keep counting", () => {
    expect(nextOrderRef(w.db)).toBe("PO-0125");
    const o = createOrder(w.db, w.operator, body());
    expect(o.orderRef).toBe("PO-0125");
    expect(createOrder(w.db, w.operator, body()).orderRef).toBe("PO-0126");
    const row = w.db.prepare("SELECT status, expected_receive_minor, confirmed_received_minor, approval_version, origin FROM orders WHERE id = ?").get(o.orderId);
    expect(row).toEqual({ status: "AWAITING_PAYMENT", expected_receive_minor: 10000, confirmed_received_minor: null, approval_version: 0, origin: "OPERATOR" });
    const allocs = w.db.prepare("SELECT recipient, kind, net_minor, approval_version, approved_by FROM allocations WHERE order_id = ? ORDER BY id").all(o.orderId) as { net_minor: number; approval_version: number; approved_by: number | null }[];
    expect(allocs.map((a) => a.net_minor)).toEqual([3700, 3200, 2300, 300, 500]);
    expect(allocs.every((a) => a.approval_version === 0 && a.approved_by === null)).toBe(true);
    expect(allocs.reduce((s, a) => s + a.net_minor, 0)).toBe(10000);
    expect(w.db.prepare("SELECT action FROM audit_events WHERE action = 'ORDER_CREATED'").all()).toHaveLength(2);
  });

  it("an order with a different shape: no logistics row when nothing is deducted", () => {
    const o = createOrder(w.db, w.operator, body({
      lines: [{ farmerId: "farmer-a", produce: "Maize", kg: 3, price: "4.00" }],
      terms: { "farmer-a": { fee: "0", deduction: "0" } },
    }));
    const kinds = (w.db.prepare("SELECT kind, net_minor FROM allocations WHERE order_id = ?").all(o.orderId) as { kind: string; net_minor: number }[]);
    expect(kinds).toEqual([{ kind: "farmer", net_minor: 1200 }]);
  });

  it("only operators can create orders", () => {
    expect(() => createOrder(w.db, w.buyer, body())).toThrow(ForbiddenError);
    expect(() => createOrder(w.db, { id: 5, role: "farmer", sessionId: "x" }, body())).toThrow(ForbiddenError);
  });

  it("invalid input creates nothing", () => {
    const before = (w.db.prepare("SELECT COUNT(*) c FROM orders").get() as { c: number }).c;
    expect(() => createOrder(w.db, w.operator, body({ lines: [{ farmerId: "farmer-a", produce: "T", kg: 1, price: "1.00" }], terms: { "farmer-a": { fee: "500", deduction: "0" } } }))).toThrow(PaymentError);
    expect((w.db.prepare("SELECT COUNT(*) c FROM orders").get() as { c: number }).c).toBe(before);
  });
});

describe("many orders: nothing assumes a single order", () => {
  it("buyers see only their own orders; farmers see only their own entries", () => {
    w.db.prepare("INSERT INTO users (username, role, name, password_hash) VALUES ('buyer2','buyer','Second Buyer','x')").run();
    const buyer2 = actorOf("buyer2");
    createOrder(w.db, w.operator, body({ buyerUserId: buyer2.id }));
    createOrder(w.db, w.operator, body({
      lines: [{ farmerId: "farmer-a", produce: "Maize", kg: 3, price: "4.00" }], terms: { "farmer-a": { fee: "100", deduction: "100" } },
    }));
    expect(listOrders(w.db, actorOf("operator")).map((o) => o.orderRef)).toEqual(["PO-0126", "PO-0125", "PO-0124"]); // newest first
    expect(listOrders(w.db, actorOf("buyer")).map((o) => o.orderRef)).toEqual(["PO-0126", "PO-0124"]);
    expect(listOrders(w.db, buyer2).map((o) => o.orderRef)).toEqual(["PO-0125"]);
    // farmer-c is not on the third order
    const c = getFarmerRecord(w.db, actorOf("farmer-c"), "farmer-c").map((r) => r.orderRef);
    expect(c).toEqual(["PO-0125", "PO-0124"]);
    const a = getFarmerRecord(w.db, actorOf("farmer-a"), "farmer-a");
    expect(a.map((r) => r.orderRef)).toEqual(["PO-0126", "PO-0125", "PO-0124"]);
    expect(JSON.stringify(c)).not.toContain("Maize");
    expect(() => getFarmerRecord(w.db, actorOf("farmer-c"), "farmer-a")).toThrow(ForbiddenError);
  });

  it("two orders run through verify, approve and payouts independently", async () => {
    const second = createOrder(w.db, w.operator, body());
    await verifyAndApprove(w); // order 1
    w.db.prepare("UPDATE orders SET status = 'RECEIVED', confirmed_received_minor = 10000, confirmed_incoming_id = 'x2' WHERE id = ?").run(second.orderId);
    await verifyPayees(w.deps, w.operator, second.orderId);
    await approveOrder(w.deps, w.operator, second.orderId, getReview(w.deps, w.operator, second.orderId).fingerprint);
    await startPayouts(w.deps, w.operator, second.orderId);
    const ops2 = w.db.prepare("SELECT order_id FROM payout_operations").all() as { order_id: number }[];
    expect(ops2).toHaveLength(4);
    expect(ops2.every((o) => o.order_id === second.orderId)).toBe(true);
    await startPayouts(w.deps, w.operator, 1);
    expect(w.db.prepare("SELECT COUNT(*) c FROM payout_operations WHERE order_id = 1").get()).toEqual({ c: 4 });
    expect(new Set((w.db.prepare("SELECT idempotency_key k FROM payout_operations").all() as { k: string }[]).map((r) => r.k)).size).toBe(8);
    // pay order 2 only: order 1 stays untouched
    await authorizePayouts(w.deps, w.operator, second.orderId);
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(w.provider.lastGrant!));
    expect(w.db.prepare("SELECT status FROM orders WHERE id = ?").get(second.orderId)).toEqual({ status: "COMPLETED" });
    expect(w.db.prepare("SELECT status FROM orders WHERE id = 1").get()).toEqual({ status: "APPROVED" });
    expect(w.db.prepare("SELECT state FROM payout_operations WHERE order_id = 1").all().every((r) => (r as { state: string }).state === "CREATED")).toBe(true);
  });
});

describe("demo: fresh order (never touches history)", () => {
  const TABLES = ["payment_resources", "payout_operations", "payout_attempts", "grant_sessions", "grant_session_operations", "wallets", "users", "receipt_links", "order_items WHERE order_id = 1", "allocations WHERE order_id = 1", "orders WHERE id = 1"];
  const snap = () => Object.fromEntries(TABLES.map((t) => [t, JSON.stringify(w.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all())]));

  it("creates a new order only: provider payments, payout history, attempts and audit events are untouched", async () => {
    await verifyAndApprove(w);
    await startPayouts(w.deps, w.operator, 1);
    await authorizePayouts(w.deps, w.operator, 1);
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(w.provider.lastGrant!));
    expect(w.db.prepare("SELECT status FROM orders WHERE id = 1").get()).toEqual({ status: "COMPLETED" });

    const before = snap();
    const auditBefore = w.db.prepare("SELECT * FROM audit_events ORDER BY id").all();
    const providerBefore = [w.provider.incomingCreated, w.provider.quotesCreated, w.provider.outgoingCalls, w.provider.grants.length];

    const a = createDemoOrder(w.db, w.operator, "10.00");
    const b = createDemoOrder(w.db, w.operator, "100.00");
    expect([a.orderRef, b.orderRef]).toEqual(["PO-0125", "PO-0126"]);

    expect(snap()).toEqual(before); // every history table identical, row for row
    const auditAfter = w.db.prepare("SELECT * FROM audit_events ORDER BY id").all();
    expect(auditAfter.slice(0, auditBefore.length)).toEqual(auditBefore); // existing audit rows unchanged
    expect(auditAfter.slice(auditBefore.length).map((r) => (r as { action: string }).action)).toEqual(["DEMO_ORDER_CREATED", "DEMO_ORDER_CREATED"]);
    expect([w.provider.incomingCreated, w.provider.quotesCreated, w.provider.outgoingCalls, w.provider.grants.length]).toEqual(providerBefore); // no provider calls
  });

  it("the fresh order is AWAITING_PAYMENT with unapproved allocations at the chosen total", () => {
    const small = createDemoOrder(w.db, w.operator, "10.00");
    const big = createDemoOrder(w.db, w.operator, "100.00");
    const row = (id: number) => w.db.prepare("SELECT status, expected_receive_minor, origin, approval_version FROM orders WHERE id = ?").get(id);
    expect(row(small.orderId)).toEqual({ status: "AWAITING_PAYMENT", expected_receive_minor: 1000, origin: "DEMO_RESET", approval_version: 0 });
    expect(row(big.orderId)).toEqual({ status: "AWAITING_PAYMENT", expected_receive_minor: 10000, origin: "DEMO_RESET", approval_version: 0 });
    expect(w.db.prepare("SELECT COUNT(*) c FROM payment_resources WHERE order_id IN (?, ?)").get(small.orderId, big.orderId)).toEqual({ c: 0 });
    expect(w.db.prepare("SELECT COUNT(*) c FROM payout_operations WHERE order_id IN (?, ?)").get(small.orderId, big.orderId)).toEqual({ c: 0 });
    expect(w.db.prepare("SELECT SUM(net_minor) s FROM allocations WHERE order_id = ?").get(big.orderId)).toEqual({ s: 10000 });
  });

  it("only operators; bad totals are refused", () => {
    expect(() => createDemoOrder(w.db, w.buyer, "10.00")).toThrow(ForbiddenError);
    expect(() => createDemoOrder(w.db, { id: 5, role: "farmer", sessionId: "x" }, "10.00")).toThrow(ForbiddenError);
    for (const bad of ["15.00", "0", "abc", "5000.00", "-10", "10.001"]) expect(() => createDemoOrder(w.db, w.operator, bad), bad).toThrow(PaymentError);
    expect((w.db.prepare("SELECT COUNT(*) c FROM orders").get() as { c: number }).c).toBe(1);
  });
});
