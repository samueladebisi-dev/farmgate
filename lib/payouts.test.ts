// Cooperative payouts against a MOCKED provider. The real provider is exercised only by a manual live run.
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, getFarmerRecord } from "./access";
import { getAuditView } from "./audit-view";
import { handleCallback, PaymentError } from "./payments";
import { authorizePayouts, getPayoutView, handlePayoutCallback, reconcilePayout, requotePayouts, retryPayout, startPayouts } from "./payouts";
import { approvedQuery, auditActions, declinedQuery, makeWorld, opStates, URLS, verifyAndApprove, type World } from "./test-world";

let w: World;
beforeEach(async () => {
  w = makeWorld();
  await verifyAndApprove(w);
});

const ops = () => w.db.prepare("SELECT * FROM payout_operations ORDER BY id").all() as { id: number; recipient: string; state: string; consent_outcome: string | null; idempotency_key: string }[];
const opId = (recipient: string) => ops().find((o) => o.recipient === recipient)!.id;
const lastGrant = () => w.provider.lastGrant!;
const orderStatus = () => (w.db.prepare("SELECT status FROM orders WHERE id = 1").get() as { status: string }).status;
const farmerA = () => ({ id: 77, role: "farmer" as const, sessionId: "F-A", linkedFarmerId: "farmer-a" });

/** start + authorize all + wallet approves + callback. */
async function payAll() {
  await startPayouts(w.deps, w.operator, 1);
  await authorizePayouts(w.deps, w.operator, 1);
  return handlePayoutCallback(w.deps, w.operator, approvedQuery(lastGrant()));
}

describe("creating payouts", () => {
  it("double click creates ONE set of operations (two concurrent requests)", async () => {
    await Promise.all([startPayouts(w.deps, w.operator, 1), startPayouts(w.deps, w.operator, 1)]);
    expect(ops()).toHaveLength(4);
    expect(new Set(ops().map((o) => o.idempotency_key)).size).toBe(4);
    expect(w.provider.incomingCreated).toBe(4); // not 8
    expect(w.provider.quotesCreated).toBe(4);
    expect(w.db.prepare("SELECT COUNT(*) c FROM payout_attempts").get()).toEqual({ c: 4 });
    await startPayouts(w.deps, w.operator, 1); // and a third click later
    expect(ops()).toHaveLength(4);
    expect(w.provider.incomingCreated).toBe(4);
  });

  it("creates one operation per payee (not the cooperative) with exact net amounts and quotes from the provider", async () => {
    await startPayouts(w.deps, w.operator, 1);
    const rows = w.db.prepare("SELECT recipient, net_minor, transfer_purpose FROM payout_operations ORDER BY id").all();
    expect(rows).toEqual([
      { recipient: "farmer-a", net_minor: 370, transfer_purpose: "FARMER_PAYOUT" },
      { recipient: "farmer-b", net_minor: 320, transfer_purpose: "FARMER_PAYOUT" },
      { recipient: "farmer-c", net_minor: 230, transfer_purpose: "FARMER_PAYOUT" },
      { recipient: "logistics", net_minor: 30, transfer_purpose: "LOGISTICS_PAYOUT" },
    ]);
    const v = getPayoutView(w.deps, w.operator, 1);
    expect(v.projectedDebitText).toBe("9.50 USD");
    expect(v.actualDebitText).toBe("0.00 USD");
    expect(v.rows.map((r) => r.quoteDebitText)).toEqual(["3.70 USD", "3.20 USD", "2.30 USD", "0.30 USD"]);
  });

  it("insufficient funds blocks release with a clear message", async () => {
    w.provider.payoutFee = 20; // each quote costs 0.20 more: total 10.30 > 10.00 received
    await expect(startPayouts(w.deps, w.operator, 1)).rejects.toThrow(/Insufficient funds/);
    await expect(authorizePayouts(w.deps, w.operator, 1)).rejects.toThrow(/Insufficient funds/);
    expect(w.provider.grants).toHaveLength(0);
    expect(w.provider.outgoingCalls).toBe(0);
    expect(auditActions(w.db)).toContain("PAYOUT_BLOCKED");
    expect(getPayoutView(w.deps, w.operator, 1)).toMatchObject({ canAuthorizeAll: false });
    expect(getPayoutView(w.deps, w.operator, 1).affordability).toMatch(/Insufficient/);
  });

  it("only operators can start, authorize, reconcile or retry", async () => {
    await startPayouts(w.deps, w.operator, 1);
    const id = opId("farmer-a");
    for (const who of [w.buyer, farmerA()]) {
      await expect(startPayouts(w.deps, who, 1)).rejects.toThrow(ForbiddenError);
      await expect(requotePayouts(w.deps, who, 1)).rejects.toThrow(ForbiddenError);
      await expect(authorizePayouts(w.deps, who, 1)).rejects.toThrow(ForbiddenError);
      await expect(reconcilePayout(w.deps, who, id)).rejects.toThrow(ForbiddenError);
      await expect(retryPayout(w.deps, who, id)).rejects.toThrow(ForbiddenError);
      expect(() => getPayoutView(w.deps, who, 1)).toThrow(ForbiddenError);
      expect(() => getAuditView(w.db, who, 1)).toThrow(ForbiddenError);
    }
  });

  it("cannot start before the split is approved", async () => {
    const w2 = makeWorld();
    await expect(startPayouts(w2.deps, w2.operator, 1)).rejects.toThrow(/not approved|approved order/);
  });
});

describe("consent and submission", () => {
  it("one consent covering all payouts: the provider runs all four, all reconcile to CONFIRMED, order COMPLETED", async () => {
    const r = await payAll();
    expect(r.kind).toBe("PROCESSING");
    expect(w.provider.grants).toHaveLength(1); // ONE consent
    expect(Number(w.provider.lastGrant!.debit.value)).toBe(950); // limit = total quoted debit
    expect(w.provider.outgoingCalls).toBe(4);
    expect(opStates(w.db)).toEqual({ "farmer-a": "CONFIRMED", "farmer-b": "CONFIRMED", "farmer-c": "CONFIRMED", logistics: "CONFIRMED" });
    expect(orderStatus()).toBe("COMPLETED");
    const v = getPayoutView(w.deps, w.operator, 1);
    expect(v.actualDebitText).toBe("9.50 USD");
    expect(v.rows.every((x) => x.words === "Confirmed" && x.outgoingId)).toBe(true);
    // provider-derived values were stored
    expect(w.db.prepare("SELECT received_minor, sent_minor, incoming_completed FROM payout_attempts WHERE operation_id = ?").get(opId("farmer-b"))).toEqual({ received_minor: 320, sent_minor: 320, incoming_completed: 1 });
    expect(auditActions(w.db)).toEqual(expect.arrayContaining(["CONSENT_STARTED", "GRANT_VERIFIED", "OUTGOING_CREATED", "PAYOUT_RECONCILED", "ORDER_COMPLETED", "PAYOUT_SUBMIT_SUMMARY"]));
  });

  it("farmer sees only their own amount, plain-word status and short reference", async () => {
    await payAll();
    const mine = getFarmerRecord(w.db, { id: 77, role: "farmer", name: "A", linkedFarmerId: "farmer-a" }, "farmer-a")[0].allocation!;
    expect(mine).toMatchObject({ farmerWords: "Paid" });
    expect(mine.net.minor).toBe(370);
    expect(mine.reference).toMatch(/^PAY-\d{3,}$/);
    const other = getFarmerRecord(w.db, { id: 78, role: "farmer", name: "B", linkedFarmerId: "farmer-b" }, "farmer-b")[0].allocation!;
    expect(other.reference).not.toBe(mine.reference);
    expect(() => getFarmerRecord(w.db, { id: 77, role: "farmer", name: "A", linkedFarmerId: "farmer-a" }, "farmer-b")).toThrow(ForbiddenError);
    const text = JSON.stringify(getFarmerRecord(w.db, { id: 78, role: "farmer", name: "B", linkedFarmerId: "farmer-b" }, "farmer-b"));
    expect(text).not.toContain(mine.reference!);
    expect(text).not.toContain("farmer-a");
  });

  it("quote expired at authorization: blocked and nothing is sent", async () => {
    await startPayouts(w.deps, w.operator, 1);
    w.clock.t += 6 * 60_000;
    await expect(authorizePayouts(w.deps, w.operator, 1)).rejects.toThrow(/expired/);
    expect(w.provider.grants).toHaveLength(0);
    expect(w.provider.outgoingCalls).toBe(0);
  });

  it("quote expires while the owner is in the wallet: submission is blocked, nothing sent, re-quote fixes it", async () => {
    await startPayouts(w.deps, w.operator, 1);
    await authorizePayouts(w.deps, w.operator, 1);
    w.clock.t += 6 * 60_000; // consent session is valid for 15 min, quotes for 5
    const r = await handlePayoutCallback(w.deps, w.operator, approvedQuery(lastGrant()));
    expect(r.kind).toBe("PROCESSING");
    expect(w.provider.outgoingCalls).toBe(0);
    expect(Object.values(opStates(w.db))).toEqual(Array(4).fill("AWAITING_CONSENT"));
    expect(JSON.stringify(w.db.prepare("SELECT metadata FROM audit_events WHERE action = 'PAYOUT_BLOCKED'").all())).toContain("QUOTE_EXPIRED");
    await requotePayouts(w.deps, w.operator, 1);
    await authorizePayouts(w.deps, w.operator, 1);
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(lastGrant()));
    expect(orderStatus()).toBe("COMPLETED");
    expect(w.provider.outgoingCalls).toBe(4);
  });

  it("declined consent: CONSENT_REJECTED / CANCELLED, payouts stay AWAITING_CONSENT, none FAILED, operator can retry", async () => {
    await startPayouts(w.deps, w.operator, 1);
    await authorizePayouts(w.deps, w.operator, 1);
    const r = await handlePayoutCallback(w.deps, w.operator, declinedQuery(lastGrant()));
    expect(r.kind).toBe("CANCELLED");
    expect(w.provider.outgoingCalls).toBe(0);
    expect(ops().every((o) => o.state === "AWAITING_CONSENT" && o.consent_outcome === "REJECTED")).toBe(true);
    expect(ops().some((o) => o.state === "FAILED")).toBe(false);
    const ev = w.db.prepare("SELECT metadata FROM audit_events WHERE action = 'CONSENT_REJECTED'").get() as { metadata: string };
    expect(JSON.parse(ev.metadata)).toMatchObject({ outcome: "CANCELLED", purpose: "PAYOUT" });
    const line = getAuditView(w.db, w.operator, 1).find((l) => l.action === "CONSENT_REJECTED")!;
    expect(line.label).toMatch(/cancelled/i);
    expect(line.label).toMatch(/not a failed transfer/i);
    expect(getPayoutView(w.deps, w.operator, 1).rows.every((x) => x.consentRejected && x.state === "AWAITING_CONSENT" && x.canAuthorize)).toBe(true);
    // authorize again, wallet approves this time
    await authorizePayouts(w.deps, w.operator, 1);
    expect(ops().every((o) => o.consent_outcome === null)).toBe(true);
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(lastGrant()));
    expect(orderStatus()).toBe("COMPLETED");
  });

  it("callback checks are shared with the buyer flow: wrong role, wrong session, replay, bad hash, expiry", async () => {
    await startPayouts(w.deps, w.operator, 1);
    await authorizePayouts(w.deps, w.operator, 1);
    const g = lastGrant();
    expect((await handlePayoutCallback(w.deps, { ...w.buyer, sessionId: w.operator.sessionId }, approvedQuery(g))).kind).toBe("REJECTED"); // wrong role, right browser session
    expect((await handlePayoutCallback(w.deps, { ...w.operator, sessionId: "OTHER" }, approvedQuery(g))).kind).toBe("REJECTED"); // wrong session
    expect((await handlePayoutCallback(w.deps, null, approvedQuery(g))).kind).toBe("REJECTED"); // no login
    expect((await handlePayoutCallback(w.deps, w.operator, approvedQuery(g, { hash: "AAAA" }))).kind).toBe("REJECTED"); // bad hash (burns the session)
    expect(w.provider.outgoingCalls).toBe(0);
    const reasons = JSON.stringify(w.db.prepare("SELECT metadata FROM audit_events WHERE action = 'GRANT_REJECTED'").all());
    for (const r of ["WRONG_USER", "WRONG_SESSION", "NO_SESSION", "HASH_MISMATCH"]) expect(reasons).toContain(r);
    // the buyer-payment handler refuses a payout session (purpose mismatch)
    expect((await handleCallback(w.deps, w.buyer, approvedQuery(g))).kind).toBe("REJECTED");
    expect(w.provider.outgoingCalls).toBe(0);
  });

  it("replay: a successful callback cannot be used twice, and a retired consent session cannot be used", async () => {
    await startPayouts(w.deps, w.operator, 1);
    await authorizePayouts(w.deps, w.operator, 1);
    const first = lastGrant();
    await authorizePayouts(w.deps, w.operator, 1); // double click: the first consent is retired
    const second = lastGrant();
    expect((await handlePayoutCallback(w.deps, w.operator, approvedQuery(first))).kind).toBe("REJECTED");
    expect(w.provider.outgoingCalls).toBe(0);
    const q = approvedQuery(second);
    expect((await handlePayoutCallback(w.deps, w.operator, q)).kind).toBe("PROCESSING");
    expect((await handlePayoutCallback(w.deps, w.operator, q)).kind).toBe("REJECTED");
    expect(w.provider.outgoingCalls).toBe(4); // exactly one outgoing payment per recipient
    expect(w.db.prepare("SELECT COUNT(*) c FROM payout_attempts WHERE outgoing_payment_id IS NOT NULL").get()).toEqual({ c: 4 });
  });

  it("two simultaneous callbacks for the same consent create each outgoing payment once", async () => {
    await startPayouts(w.deps, w.operator, 1);
    await authorizePayouts(w.deps, w.operator, 1);
    const q = approvedQuery(lastGrant());
    const [a, b] = await Promise.all([handlePayoutCallback(w.deps, w.operator, q), handlePayoutCallback(w.deps, w.operator, q)]);
    expect([a.kind, b.kind].sort()).toEqual(["PROCESSING", "REJECTED"]);
    expect(w.provider.outgoingCalls).toBe(4);
  });

  it("tokens never reach the audit log or plain database columns", async () => {
    await payAll();
    const everything = JSON.stringify(w.db.prepare("SELECT * FROM audit_events").all()) + JSON.stringify(w.db.prepare("SELECT * FROM grant_sessions").all());
    expect(everything).not.toContain("SECRET-ACCESS-TOKEN");
    expect(everything).not.toContain("SECRET-CONTINUE-TOKEN");
  });
});

describe("when the provider does not cooperate", () => {
  it("a consent that covers only ONE payment: first is created, the next is refused, the rest wait; per-recipient consents finish the job", async () => {
    w.provider.grantMode = "single";
    await startPayouts(w.deps, w.operator, 1);
    await authorizePayouts(w.deps, w.operator, 1);
    const r = await handlePayoutCallback(w.deps, w.operator, approvedQuery(lastGrant()));
    expect(r.kind).toBe("PROCESSING");
    expect(r.message).toMatch(/did not cover the remaining/);
    expect(opStates(w.db)).toEqual({ "farmer-a": "CONFIRMED", "farmer-b": "FAILED", "farmer-c": "AWAITING_CONSENT", logistics: "AWAITING_CONSENT" });
    const summary = w.db.prepare("SELECT metadata FROM audit_events WHERE action = 'PAYOUT_SUBMIT_SUMMARY'").get() as { metadata: string };
    expect(JSON.parse(summary.metadata)).toMatchObject({ grantScope: "ALL", grantDidNotCoverAll: true, created: 1, grant_limit: 1 });
    expect(w.provider.outgoingCalls).toBe(2);
    // fall back: one consent per recipient
    await authorizePayouts(w.deps, w.operator, 1, opId("farmer-c"));
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(lastGrant()));
    await authorizePayouts(w.deps, w.operator, 1, opId("logistics"));
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(lastGrant()));
    // the refused one needs an operator-started new attempt
    await retryPayout(w.deps, w.operator, opId("farmer-b"));
    expect(opStates(w.db)["farmer-b"]).toBe("CREATED");
    await authorizePayouts(w.deps, w.operator, 1, opId("farmer-b"));
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(lastGrant()));
    expect(opStates(w.db)).toEqual({ "farmer-a": "CONFIRMED", "farmer-b": "CONFIRMED", "farmer-c": "CONFIRMED", logistics: "CONFIRMED" });
    expect(orderStatus()).toBe("COMPLETED");
    expect(w.provider.grants).toHaveLength(4); // 1 for all + 3 single
  });

  it("timeout after submitting becomes UNKNOWN, is reconciled, blocks retry, and is never blindly retried", async () => {
    w.provider.outgoingModeFor.set(URLS.a, "unclear");
    await startPayouts(w.deps, w.operator, 1);
    await authorizePayouts(w.deps, w.operator, 1);
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(lastGrant()));
    expect(opStates(w.db)["farmer-a"]).toBe("UNKNOWN");
    expect(opStates(w.db)["farmer-b"]).toBe("CONFIRMED"); // others are not held up
    const callsForA = w.provider.outgoingCalls;
    await expect(retryPayout(w.deps, w.operator, opId("farmer-a"))).rejects.toThrow(PaymentError); // UNKNOWN is not FAILED
    await expect(authorizePayouts(w.deps, w.operator, 1, opId("farmer-a"))).rejects.toThrow(/Nothing is waiting/);
    expect(w.provider.outgoingCalls).toBe(callsForA);
    expect(getPayoutView(w.deps, w.operator, 1).rows.find((r) => r.recipient === "farmer-a")).toMatchObject({ words: "Unknown: needs reconciliation", canRetry: false, canReconcile: true });
    // provider shows nothing received yet: stays UNKNOWN
    await reconcilePayout(w.deps, w.operator, opId("farmer-a"));
    expect(opStates(w.db)["farmer-a"]).toBe("UNKNOWN");
    expect(orderStatus()).toBe("APPROVED");
    // provider shows the money arrived: reconciliation resolves it
    const incoming = (w.db.prepare("SELECT incoming_payment_id i FROM payout_attempts WHERE operation_id = ?").get(opId("farmer-a")) as { i: string }).i;
    w.provider.setReceived(incoming, 370, true);
    await reconcilePayout(w.deps, w.operator, opId("farmer-a"));
    expect(opStates(w.db)["farmer-a"]).toBe("CONFIRMED");
    expect(orderStatus()).toBe("COMPLETED");
    expect(w.provider.outgoingCalls).toBe(callsForA); // still never retried
  });

  it("a clear refusal is FAILED; a new attempt is allowed only then, only for an operator, with a new attempt number", async () => {
    w.provider.outgoingModeFor.set(URLS.a, "rejected");
    await startPayouts(w.deps, w.operator, 1);
    // not allowed while nothing failed
    await expect(retryPayout(w.deps, w.operator, opId("farmer-a"))).rejects.toThrow(/not allowed/);
    await authorizePayouts(w.deps, w.operator, 1);
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(lastGrant()));
    expect(opStates(w.db)["farmer-a"]).toBe("FAILED");
    expect(opStates(w.db)["farmer-b"]).toBe("CONFIRMED");
    // confirmed payouts cannot be retried either
    await expect(retryPayout(w.deps, w.operator, opId("farmer-b"))).rejects.toThrow(/not allowed/);
    await expect(retryPayout(w.deps, w.buyer, opId("farmer-a"))).rejects.toThrow(ForbiddenError);
    w.provider.outgoingModeFor.delete(URLS.a);
    await retryPayout(w.deps, w.operator, opId("farmer-a"));
    expect(w.db.prepare("SELECT attempt_number FROM payout_attempts WHERE operation_id = ? ORDER BY attempt_number").all(opId("farmer-a"))).toEqual([{ attempt_number: 1 }, { attempt_number: 2 }]);
    expect(opStates(w.db)["farmer-a"]).toBe("CREATED");
    await authorizePayouts(w.deps, w.operator, 1, opId("farmer-a"));
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(lastGrant()));
    expect(opStates(w.db)["farmer-a"]).toBe("CONFIRMED");
    expect(orderStatus()).toBe("COMPLETED");
  });

  it("changing an approved input before release invalidates the approval and blocks payouts", async () => {
    await startPayouts(w.deps, w.operator, 1);
    w.db.prepare("UPDATE wallets SET public_name = 'Somebody Else' WHERE owner = 'farmer-b'").run(); // also wipes verification
    await expect(authorizePayouts(w.deps, w.operator, 1)).rejects.toThrow(/approval was removed|changed/);
    expect(orderStatus()).toBe("RECEIVED");
    expect(w.provider.grants).toHaveLength(0);
  });

  it("a payee wallet that changed at the provider blocks release", async () => {
    await startPayouts(w.deps, w.operator, 1);
    w.provider.walletOverrides.set(URLS.logistics, { authServer: "https://auth.interledger-test.dev/changed" });
    await expect(authorizePayouts(w.deps, w.operator, 1)).rejects.toThrow(PaymentError);
    expect(w.provider.grants).toHaveLength(0);
  });
});
