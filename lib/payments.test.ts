// Payment flow tests against a MOCKED provider. The real provider is exercised only by a manual live run.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "./access";
import { applyMigrations, openDb, type Db } from "./db";
import {
  getPaymentView, handleCallback, PaymentError, quoteOrder, reconcileForActor, reconcileOrder, startAuthorization, type Deps, type PayActor,
} from "./payments";
import {
  ProviderRejected, ProviderUnclear, type IncomingInfo, type OutgoingInfo, type PaymentProvider, type PendingGrantInfo, type ProviderAmount, type QuoteInfo, type WalletInfo,
} from "./provider";
import { seedDatabase } from "./seed";

process.env.SESSION_SECRET = "test-session-secret-for-token-box";
const SECRET_TOKEN = "SECRET-ACCESS-TOKEN-123";
const SECRET_CONTINUE = "SECRET-CONTINUE-TOKEN-456";
const EXPECTED = 1000; // 10.00 USD
const DEBIT = 920; // 9.20 EUR, the "live" quote

class MockProvider implements PaymentProvider {
  clock: { t: number };
  incoming = new Map<string, IncomingInfo>();
  outgoing = new Map<string, OutgoingInfo>();
  n = 0;
  outgoingCalls = 0;
  incomingCreated = 0;
  outgoingMode: "ok" | "rejected" | "unclear" = "ok";
  settleOnPay = true; // paying makes the incoming payment receive the full amount
  completeCalls = 0;
  lastGrant?: { finishUri: string; nonce: string; serverNonce: string; debit: ProviderAmount; authServer: string };
  constructor(clock: { t: number }) { this.clock = clock; }

  async getWallet(url: string): Promise<WalletInfo> {
    const eur = url.includes("da5d080e");
    return { id: url, assetCode: eur ? "EUR" : "USD", assetScale: 2, authServer: eur ? "https://auth.test/buyer" : "https://auth.test/coop", resourceServer: "https://rs.test" };
  }
  async createIncomingPayment({ amount, expiresAt }: { amount: ProviderAmount; expiresAt: string }): Promise<IncomingInfo> {
    this.incomingCreated++;
    const id = `https://rs.test/incoming-payments/${++this.n}`;
    const info: IncomingInfo = { id, completed: false, expiresAt, incomingAmount: amount, receivedAmount: { ...amount, value: "0" } };
    this.incoming.set(id, info);
    return info;
  }
  async getIncomingPayment({ id }: { id: string }) { return { ...this.incoming.get(id)! }; }
  async completeIncomingPayment({ id }: { id: string }) {
    this.completeCalls++;
    const i = this.incoming.get(id)!;
    i.completed = true;
    return { ...i };
  }
  async createQuote({ incomingId }: { incomingId: string }): Promise<QuoteInfo> {
    const inc = this.incoming.get(incomingId)!;
    return {
      id: `https://rs.test/quotes/${++this.n}`,
      debitAmount: { value: String(DEBIT), assetCode: "EUR", assetScale: 2 },
      receiveAmount: inc.incomingAmount!,
      expiresAt: new Date(this.clock.t + 5 * 60_000).toISOString(),
    };
  }
  async startOutgoingGrant(a: { buyer: WalletInfo; debit: ProviderAmount; finishUri: string; nonce: string }): Promise<PendingGrantInfo> {
    this.lastGrant = { finishUri: a.finishUri, nonce: a.nonce, serverNonce: "server-nonce-xyz", debit: a.debit, authServer: a.buyer.authServer };
    return { redirectUrl: "https://wallet.test/consent/abc", serverNonce: "server-nonce-xyz", continueUri: "https://auth.test/continue/1", continueToken: SECRET_CONTINUE };
  }
  async finishOutgoingGrant() { return { accessToken: SECRET_TOKEN }; }
  async createOutgoingPayment({ quoteId }: { quoteId: string }): Promise<OutgoingInfo> {
    this.outgoingCalls++;
    if (this.outgoingMode === "rejected") throw new ProviderRejected("quote expired (HTTP 400)");
    if (this.outgoingMode === "unclear") throw new ProviderUnclear("timeout");
    const o: OutgoingInfo = {
      id: `https://rs.test/outgoing-payments/${++this.n}`, failed: false,
      debitAmount: { value: String(DEBIT), assetCode: "EUR", assetScale: 2 }, sentAmount: { value: String(DEBIT), assetCode: "EUR", assetScale: 2 },
      receiveAmount: { value: String(EXPECTED), assetCode: "USD", assetScale: 2 },
    };
    this.outgoing.set(o.id, o);
    void quoteId;
    if (this.settleOnPay) this.setReceived([...this.incoming.keys()].at(-1)!, EXPECTED, true);
    return o;
  }
  async getOutgoingPayment({ id }: { id: string }) { return { ...this.outgoing.get(id)! }; }

  setReceived(incomingId: string, minor: number, completed: boolean) {
    const i = this.incoming.get(incomingId)!;
    i.receivedAmount = { value: String(minor), assetCode: "USD", assetScale: 2 };
    i.completed = completed;
  }
  latestIncomingId() { return [...this.incoming.keys()].at(-1)!; }
}

let db: Db, clock: { t: number }, provider: MockProvider, deps: Deps;
const buyer: PayActor = { id: 0, role: "buyer", sessionId: "SESSION-1" };
const operator: PayActor = { id: 0, role: "operator", sessionId: "SESSION-OP" };

const hashFor = (g: NonNullable<MockProvider["lastGrant"]>, ref: string) =>
  createHash("sha256").update(`${g.nonce}\n${g.serverNonce}\n${ref}\n${g.authServer}`).digest("base64");

/** Build the query the wallet would send back after consent. */
function approvedQuery(overrides: Record<string, string> = {}): URLSearchParams {
  const g = provider.lastGrant!;
  const u = new URL(g.finishUri);
  const q = new URLSearchParams(u.search);
  q.set("interact_ref", "interact-ref-1");
  q.set("hash", hashFor(g, "interact-ref-1"));
  for (const [k, v] of Object.entries(overrides)) v === "" ? q.delete(k) : q.set(k, v);
  return q;
}
const auditActions = () => (db.prepare("SELECT action FROM audit_events ORDER BY id").all() as { action: string }[]).map((r) => r.action);
const order = () => db.prepare("SELECT * FROM orders WHERE id = 1").get() as Record<string, unknown>;
const resource = () => db.prepare("SELECT * FROM payment_resources ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;

async function authorizedAndReady() {
  await quoteOrder(deps, buyer, 1);
  await startAuthorization(deps, buyer, 1);
}

beforeEach(() => {
  db = openDb(":memory:");
  applyMigrations(db);
  seedDatabase(db, { orderTotalMinor: EXPECTED, passwords: { buyer: "b", operator: "o", farmerA: "a", farmerB: "bb", farmerC: "c" } });
  buyer.id = (db.prepare("SELECT id FROM users WHERE username='buyer'").get() as { id: number }).id;
  operator.id = (db.prepare("SELECT id FROM users WHERE username='operator'").get() as { id: number }).id;
  clock = { t: Date.parse("2026-11-18T12:00:00Z") };
  provider = new MockProvider(clock);
  deps = { db, provider, appBaseUrl: "http://localhost:3000", now: () => clock.t };
});

describe("quote", () => {
  it("creates the incoming payment for the fixed amount and a quote, and stores it", async () => {
    const r = await quoteOrder(deps, buyer, 1);
    expect(provider.incomingCreated).toBe(1);
    expect(r).toMatchObject({ state: "CREATED", quote_debit_minor: DEBIT, quote_debit_asset: "EUR", receive_minor: EXPECTED, receive_asset: "USD" });
    const v = getPaymentView(deps, buyer, 1);
    expect(v).toMatchObject({ expectedText: "10.00 USD", quoteDebitText: "9.20 EUR", canAuthorize: true, canQuote: false, statusWords: "Quote ready, approval needed" });
    expect(v.buyerWalletVerifiedAt).not.toBeNull();
    expect(auditActions()).toContain("QUOTE_CREATED");
    expect(v.operator).toBeUndefined(); // provider ids are operator-only
    expect(JSON.stringify(v)).not.toContain("rs.test");
  });

  it("an expired quote blocks authorization and offers a new quote", async () => {
    await quoteOrder(deps, buyer, 1);
    clock.t += 6 * 60_000;
    const v = getPaymentView(deps, buyer, 1);
    expect(v).toMatchObject({ canAuthorize: false, canQuote: true, quoteExpired: true });
    await expect(startAuthorization(deps, buyer, 1)).rejects.toThrow(/expired/);
    const again = await quoteOrder(deps, buyer, 1);
    expect(again.state).toBe("CREATED");
    expect(provider.incomingCreated).toBeLessThanOrEqual(2);
    expect(getPaymentView(deps, buyer, 1).canAuthorize).toBe(true);
  });

  it("a buyer cannot touch someone else's order", async () => {
    db.prepare("INSERT INTO users (username, role, name, password_hash) VALUES ('buyer2','buyer','Other','x')").run();
    const other: PayActor = { id: (db.prepare("SELECT id FROM users WHERE username='buyer2'").get() as { id: number }).id, role: "buyer", sessionId: "S9" };
    await expect(quoteOrder(deps, other, 1)).rejects.toThrow(ForbiddenError);
    await expect(startAuthorization(deps, other, 1)).rejects.toThrow(ForbiddenError);
    await expect(reconcileForActor(deps, other, 1)).rejects.toThrow(ForbiddenError);
    expect(() => getPaymentView(deps, other, 1)).toThrow(ForbiddenError);
  });

  it("rejects a quote whose receive amount differs from the order", async () => {
    provider.createQuote = async ({ incomingId }) => ({ id: "q", debitAmount: { value: "900", assetCode: "EUR", assetScale: 2 }, receiveAmount: { ...provider.incoming.get(incomingId)!.incomingAmount!, value: "999" } });
    await expect(quoteOrder(deps, buyer, 1)).rejects.toThrow(PaymentError);
    expect(db.prepare("SELECT COUNT(*) c FROM payment_resources").get()).toEqual({ c: 0 });
    expect(auditActions()).toContain("QUOTE_FAILED");
  });
});

describe("callback rejection cases", () => {
  beforeEach(authorizedAndReady);

  it("consent start creates a session bound to the login session, wallet, order, purpose and nonce", () => {
    const g = db.prepare("SELECT * FROM grant_sessions").get() as Record<string, unknown>;
    expect(g).toMatchObject({ initiator_session_id: "SESSION-1", order_id: 1, purpose: "BUYER_PAYMENT" });
    expect(g.nonce).toBeTruthy();
    expect(g.grant_reference).toBeTruthy();
    expect(auditActions()).toContain("CONSENT_STARTED");
    expect(getPaymentView(deps, buyer, 1).statusWords).toBe("Waiting for your approval in the wallet");
  });

  it("success path: verifies, continues the grant, creates the outgoing payment and reconciles to RECEIVED", async () => {
    const r = await handleCallback(deps, buyer, approvedQuery());
    expect(r.kind).toBe("PROCESSING");
    expect(provider.outgoingCalls).toBe(1);
    expect(order()).toMatchObject({ status: "RECEIVED", confirmed_received_minor: EXPECTED });
    expect(resource()).toMatchObject({ state: "CONFIRMED" });
    expect(auditActions()).toEqual(expect.arrayContaining(["GRANT_VERIFIED", "OUTGOING_CREATED", "RECONCILED", "ORDER_RECEIVED"]));
    expect(getPaymentView(deps, buyer, 1).statusWords).toBe("Paid");
  });

  it("wrong login session is rejected and audited, no payment made", async () => {
    const r = await handleCallback(deps, { ...buyer, sessionId: "SESSION-OTHER" }, approvedQuery());
    expect(r.kind).toBe("REJECTED");
    expect(provider.outgoingCalls).toBe(0);
    expect(JSON.stringify(db.prepare("SELECT metadata FROM audit_events WHERE action='GRANT_REJECTED'").all())).toContain("WRONG_SESSION");
    expect(order()).toMatchObject({ status: "AWAITING_PAYMENT" });
  });

  it("no login at all is rejected and audited", async () => {
    const r = await handleCallback(deps, null, approvedQuery());
    expect(r.kind).toBe("REJECTED");
    expect(JSON.stringify(db.prepare("SELECT metadata FROM audit_events WHERE action='GRANT_REJECTED'").all())).toContain("NO_SESSION");
    expect(provider.outgoingCalls).toBe(0);
  });

  it("replay: the same callback twice only pays once", async () => {
    const q = approvedQuery();
    expect((await handleCallback(deps, buyer, q)).kind).toBe("PROCESSING");
    const second = await handleCallback(deps, buyer, q);
    expect(second.kind).toBe("REJECTED");
    expect(provider.outgoingCalls).toBe(1);
    expect(JSON.stringify(db.prepare("SELECT metadata FROM audit_events WHERE action='GRANT_REJECTED'").all())).toContain("REPLAY");
  });

  it("two simultaneous callbacks: only one wins", async () => {
    const q = approvedQuery();
    const [a, b] = await Promise.all([handleCallback(deps, buyer, q), handleCallback(deps, buyer, q)]);
    expect([a.kind, b.kind].sort()).toEqual(["PROCESSING", "REJECTED"]);
    expect(provider.outgoingCalls).toBe(1);
  });

  it("bad hash is rejected, no payment made", async () => {
    const r = await handleCallback(deps, buyer, approvedQuery({ hash: "AAAA" }));
    expect(r.kind).toBe("REJECTED");
    expect(provider.outgoingCalls).toBe(0);
    expect(JSON.stringify(db.prepare("SELECT metadata FROM audit_events WHERE action='GRANT_REJECTED'").all())).toContain("HASH_MISMATCH");
  });

  it("tampered interact_ref fails the hash check", async () => {
    expect((await handleCallback(deps, buyer, approvedQuery({ interact_ref: "other" }))).kind).toBe("REJECTED");
    expect(provider.outgoingCalls).toBe(0);
  });

  it("order or purpose mismatch is rejected", async () => {
    expect((await handleCallback(deps, buyer, approvedQuery({ order: "99" }))).kind).toBe("REJECTED");
    // a rejected attempt must not burn... it does burn the session on purpose only after these checks, so retry works:
    expect((await handleCallback(deps, buyer, approvedQuery({ purpose: "PAYOUT" }))).kind).toBe("REJECTED");
    expect(provider.outgoingCalls).toBe(0);
    expect((await handleCallback(deps, buyer, approvedQuery())).kind).toBe("PROCESSING");
  });

  it("expired consent session is rejected", async () => {
    clock.t += 20 * 60_000;
    expect((await handleCallback(deps, buyer, approvedQuery())).kind).toBe("REJECTED");
    expect(JSON.stringify(db.prepare("SELECT metadata FROM audit_events WHERE action='GRANT_REJECTED'").all())).toContain("SESSION_EXPIRED");
    expect(provider.outgoingCalls).toBe(0);
  });

  it("another buyer in the same browser session id cannot complete it", async () => {
    db.prepare("INSERT INTO users (username, role, name, password_hash) VALUES ('buyer2','buyer','Other','x')").run();
    const other: PayActor = { id: (db.prepare("SELECT id FROM users WHERE username='buyer2'").get() as { id: number }).id, role: "buyer", sessionId: "SESSION-1" };
    expect((await handleCallback(deps, other, approvedQuery())).kind).toBe("REJECTED");
    expect(provider.outgoingCalls).toBe(0);
  });

  it("buyer declined consent: CONSENT_REJECTED / CANCELLED, never FAILED, and a new attempt is possible", async () => {
    const r = await handleCallback(deps, buyer, approvedQuery({ result: "grant_rejected", hash: "", interact_ref: "" }));
    expect(r.kind).toBe("CANCELLED");
    expect(provider.outgoingCalls).toBe(0);
    expect(resource()).toMatchObject({ state: "AWAITING_CONSENT", consent_outcome: "REJECTED" });
    expect(db.prepare("SELECT state FROM payment_resources WHERE state = 'FAILED'").all()).toHaveLength(0);
    const ev = db.prepare("SELECT metadata FROM audit_events WHERE action='CONSENT_REJECTED'").get() as { metadata: string };
    expect(JSON.parse(ev.metadata)).toMatchObject({ outcome: "CANCELLED" });
    expect(getPaymentView(deps, buyer, 1)).toMatchObject({ consentRejected: true, canAuthorize: true });
    // new attempt
    await startAuthorization(deps, buyer, 1);
    expect(resource()).toMatchObject({ state: "AWAITING_CONSENT", consent_outcome: null });
    expect((await handleCallback(deps, buyer, approvedQuery())).kind).toBe("PROCESSING");
    expect(order()).toMatchObject({ status: "RECEIVED" });
  });

  it("a rejection callback cannot be replayed either", async () => {
    const q = approvedQuery({ result: "grant_rejected", hash: "", interact_ref: "" });
    expect((await handleCallback(deps, buyer, q)).kind).toBe("CANCELLED");
    expect((await handleCallback(deps, buyer, q)).kind).toBe("REJECTED");
  });

  it("tokens are encrypted at rest and never appear in the audit log", async () => {
    await handleCallback(deps, buyer, approvedQuery());
    const stored = JSON.stringify(db.prepare("SELECT * FROM payment_resources").all()) + JSON.stringify(db.prepare("SELECT * FROM grant_sessions").all());
    expect(stored).not.toContain(SECRET_TOKEN);
    expect(stored).not.toContain(SECRET_CONTINUE);
    const audits = JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
    expect(audits).not.toContain(SECRET_TOKEN);
    expect(audits).not.toContain(SECRET_CONTINUE);
    expect(audits).not.toContain("interact-ref-1");
  });
});

describe("outgoing payment problems", () => {
  beforeEach(authorizedAndReady);

  it("provider clearly refuses: payment FAILED, buyer can get a new quote", async () => {
    provider.outgoingMode = "rejected";
    const r = await handleCallback(deps, buyer, approvedQuery());
    expect(r.kind).toBe("REJECTED");
    expect(resource()).toMatchObject({ state: "FAILED" });
    expect(order()).toMatchObject({ status: "AWAITING_PAYMENT" });
    expect(getPaymentView(deps, buyer, 1)).toMatchObject({ canQuote: true, canAuthorize: false });
  });

  it("timeout after submit: UNKNOWN, reconciled, never blindly retried", async () => {
    provider.outgoingMode = "unclear";
    const r = await handleCallback(deps, buyer, approvedQuery());
    expect(r.kind).toBe("PROCESSING");
    expect(resource()).toMatchObject({ state: "UNKNOWN" });
    expect(provider.outgoingCalls).toBe(1);
    const v = getPaymentView(deps, buyer, 1);
    expect(v).toMatchObject({ statusWords: "Needs checking", canQuote: false, canAuthorize: false, canReconcile: true });
    await expect(quoteOrder(deps, buyer, 1)).rejects.toThrow(/already in progress|needs checking/);
    expect(order()).toMatchObject({ status: "AWAITING_PAYMENT" });

    // The provider turns out to have received the money: reconciliation resolves UNKNOWN -> CONFIRMED.
    provider.setReceived(provider.latestIncomingId(), EXPECTED, true);
    await reconcileForActor(deps, buyer, 1);
    expect(resource()).toMatchObject({ state: "CONFIRMED" });
    expect(order()).toMatchObject({ status: "RECEIVED", confirmed_received_minor: EXPECTED });
    expect(provider.outgoingCalls).toBe(1); // still exactly one attempt
  });

  it("UNKNOWN stays UNKNOWN while the provider shows nothing received", async () => {
    provider.outgoingMode = "unclear";
    await handleCallback(deps, buyer, approvedQuery());
    await reconcileForActor(deps, operator, 1);
    expect(resource()).toMatchObject({ state: "UNKNOWN" });
    expect(order()).toMatchObject({ status: "AWAITING_PAYMENT", confirmed_received_minor: null });
  });
});

describe("reconciliation rules against the provider", () => {
  beforeEach(async () => {
    provider.settleOnPay = false; // we decide what the provider reports
    await authorizedAndReady();
    await handleCallback(deps, buyer, approvedQuery());
  });

  it("exact match: order RECEIVED with confirmed amount; stored from the provider", async () => {
    provider.setReceived(provider.latestIncomingId(), EXPECTED, true);
    await reconcileOrder(deps, "test", 1);
    expect(order()).toMatchObject({ status: "RECEIVED", confirmed_received_minor: EXPECTED, version: 2 });
    expect(resource()).toMatchObject({ received_minor: EXPECTED, received_asset: "USD", incoming_completed: 1, state: "CONFIRMED", sent_minor: DEBIT, sent_asset: "EUR" });
  });

  it("fully received but not completed: the app completes it, then confirms", async () => {
    provider.setReceived(provider.latestIncomingId(), EXPECTED, false);
    await reconcileOrder(deps, "test", 1);
    expect(provider.completeCalls).toBe(1);
    expect(order()).toMatchObject({ status: "RECEIVED" });
  });

  it("still waiting: order stays AWAITING_PAYMENT, payment stays SUBMITTED", async () => {
    await reconcileOrder(deps, "test", 1);
    expect(order()).toMatchObject({ status: "AWAITING_PAYMENT", confirmed_received_minor: null });
    expect(resource()).toMatchObject({ state: "SUBMITTED" });
    expect(getPaymentView(deps, buyer, 1).statusWords).toBe("Processing");
  });

  it("underpayment blocks the order and is audited", async () => {
    provider.setReceived(provider.latestIncomingId(), 900, true);
    await reconcileOrder(deps, "test", 1);
    expect(order()).toMatchObject({ status: "AWAITING_PAYMENT", confirmed_received_minor: null, exception: "UNDERPAYMENT" });
    expect(auditActions()).toContain("EXCEPTION");
  });

  it("overpayment is an exception; nothing is confirmed so the extra is never distributed", async () => {
    provider.setReceived(provider.latestIncomingId(), 1200, true);
    await reconcileOrder(deps, "test", 1);
    expect(order()).toMatchObject({ status: "AWAITING_PAYMENT", confirmed_received_minor: null, exception: "OVERPAYMENT" });
    expect(String(order().exception_detail)).toContain("extra 200");
  });

  it("a second incoming payment is recorded but does not trigger the order twice", async () => {
    provider.setReceived(provider.latestIncomingId(), EXPECTED, true);
    await reconcileOrder(deps, "test", 1);
    const firstIncoming = order().confirmed_incoming_id;
    // A second incoming payment for the same order shows up with money on it.
    provider.incoming.set("https://rs.test/incoming-payments/dup", { id: "https://rs.test/incoming-payments/dup", completed: true, receivedAmount: { value: "1000", assetCode: "USD", assetScale: 2 } });
    db.prepare("INSERT INTO payment_resources (order_id, direction, incoming_payment_id, state) VALUES (1, 'INBOUND', 'https://rs.test/incoming-payments/dup', 'CREATED')").run();
    await reconcileOrder(deps, "test", 1);
    await reconcileOrder(deps, "test", 1); // and again: still idempotent
    expect(order()).toMatchObject({ status: "RECEIVED", confirmed_received_minor: EXPECTED, version: 2, exception: "DUPLICATE_PAYMENT", confirmed_incoming_id: firstIncoming });
    expect(auditActions().filter((a) => a === "ORDER_RECEIVED")).toHaveLength(1);
    expect(auditActions().filter((a) => a === "EXCEPTION")).toHaveLength(1);
    expect(db.prepare("SELECT COUNT(*) c FROM payment_resources WHERE incoming_payment_id LIKE '%dup'").get()).toEqual({ c: 1 });
  });

  it("only operator or the owning buyer may reconcile", async () => {
    const farmer: PayActor = { id: 99, role: "farmer", sessionId: "F" };
    await expect(reconcileForActor(deps, farmer, 1)).rejects.toThrow(ForbiddenError);
    await expect(reconcileForActor(deps, operator, 1)).resolves.toBeTruthy();
  });

  it("operator sees provider ids; the buyer view does not", () => {
    const op = getPaymentView(deps, operator, 1);
    expect(op.operator?.resources[0].incomingId).toContain("rs.test/incoming-payments/");
    expect(JSON.stringify(getPaymentView(deps, buyer, 1))).not.toContain("rs.test");
  });
});
