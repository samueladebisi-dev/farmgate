// Server-side payment module: buyer -> cooperative, using the call shapes proven in spike/pay.ts.
// Everything provider-related goes through the `PaymentProvider` interface so tests can mock it.
// Keys and tokens never leave the server; tokens are stored only encrypted and never audited or logged.
import { createHash, randomUUID } from "node:crypto";
import { ForbiddenError, NotFoundError, type Role } from "./access";
import { audit } from "./audit";
import type { Db } from "./db";
import { formatMoney } from "./money";
import { STATE_WORDS, transition, type PayoutState } from "./payout-state";
import { evaluateReceipts, type IncomingFacts } from "./reconcile-rules";
import { ProviderRejected, type OutgoingInfo, type PaymentProvider, type ProviderAmount, type WalletInfo } from "./provider";
import { open, seal } from "./secretbox";

export const PURPOSE = "BUYER_PAYMENT";
/** Authorization is blocked unless the quote has at least this long left (consent takes time). */
export const MIN_QUOTE_MS = 60_000;
const FALLBACK_QUOTE_MS = 5 * 60_000; // used only if the provider gives no quote expiry
const GRANT_SESSION_MS = 15 * 60_000;
const INCOMING_VALID_MS = 60 * 60_000;

export type Deps = { db: Db; provider: PaymentProvider; appBaseUrl: string; now?: () => number };
export type PayActor = { id: number; role: Role; sessionId: string; name?: string };

/** An error whose message is safe to show to the user. `auditId` points at the audit row with details. */
export class PaymentError extends Error {
  constructor(message: string, public auditId?: number, public status = 400) {
    super(message);
  }
}

const nowMs = (d: Deps) => (d.now ? d.now() : Date.now());
const iso = (ms: number) => new Date(ms).toISOString();
const who = (a: PayActor) => `${a.role}:${a.id}`;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------
type OrderRow = {
  id: number; order_ref: string; buyer_user_id: number; buyer_wallet_id: number; cooperative_wallet_id: number;
  expected_receive_minor: number; confirmed_received_minor: number | null; asset_code: string; asset_scale: number;
  status: string; version: number; exception: string | null; exception_detail: string | null; confirmed_incoming_id: string | null;
};
type WalletRow = { id: number; canonical_url: string; asset_code: string; asset_scale: number; verified_at: string | null };
export type ResourceRow = {
  id: number; order_id: number; state: PayoutState; incoming_payment_id: string | null; quote_id: string | null; outgoing_payment_id: string | null;
  quote_debit_minor: number | null; quote_debit_asset: string | null; quote_debit_scale: number | null;
  receive_minor: number | null; receive_asset: string | null; receive_scale: number | null;
  quote_expires_at: string | null; incoming_expires_at: string | null; incoming_completed: number | null;
  received_minor: number | null; received_asset: string | null; received_scale: number | null;
  sent_minor: number | null; sent_asset: string | null; sent_scale: number | null;
  outgoing_failed: number | null; consent_outcome: "REJECTED" | null; outgoing_token_enc: string | null; buyer_wallet_id: number | null;
};
type GrantRow = {
  id: number; initiator_session_id: string; wallet_id: number; order_id: number; nonce: string; grant_reference: string | null;
  expires_at: string; outcome: string | null; purpose: string; payment_resource_id: number | null; server_nonce: string | null;
  grant_endpoint: string | null; continue_uri: string | null; continue_token_enc: string | null; used_at: string | null;
};

function loadOrder(db: Db, id: number): OrderRow {
  const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(id) as OrderRow | undefined;
  if (!o) throw new NotFoundError("Order not found");
  return o;
}
const wallet = (db: Db, id: number) => db.prepare("SELECT id, canonical_url, asset_code, asset_scale, verified_at FROM wallets WHERE id = ?").get(id) as WalletRow;
const latestResource = (db: Db, orderId: number) =>
  db.prepare("SELECT * FROM payment_resources WHERE order_id = ? AND direction = 'INBOUND' ORDER BY id DESC LIMIT 1").get(orderId) as ResourceRow | undefined;
const resourceById = (db: Db, id: number) => db.prepare("SELECT * FROM payment_resources WHERE id = ?").get(id) as ResourceRow;

/** Buyers can only touch their own order. */
function assertBuyerOwns(actor: PayActor, o: OrderRow) {
  if (actor.role !== "buyer" || o.buyer_user_id !== actor.id) throw new ForbiddenError("This is not your order");
}
/** Reconcile: the operator, or the buyer for their own order. */
function assertCanReconcile(actor: PayActor, o: OrderRow) {
  if (actor.role === "operator") return;
  assertBuyerOwns(actor, o);
}

const amt = (minor: number, code: string, scale: number): ProviderAmount => ({ value: String(minor), assetCode: code, assetScale: scale });
function minorOf(a: ProviderAmount): number {
  const n = Number(a.value);
  if (!Number.isSafeInteger(n) || n < 0 || !/^\d+$/.test(a.value)) throw new Error(`Provider returned a non-integer amount: ${a.value}`);
  return n;
}
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

/** Write an audit row for a failure and return a user-safe error pointing at it. */
function failure(d: Deps, actor: PayActor, action: string, orderId: number, userMessage: string, detail: unknown): PaymentError {
  // Provider error text is not secret (the SDK never puts tokens/keys in it), so it is shown to help diagnose live runs.
  const message = `${userMessage}: ${String(detail).slice(0, 300)}`;
  const id = audit(d.db, { actor: who(actor), action, entityType: "order", entityId: orderId, metadata: { message } });
  return new PaymentError(message, id);
}

// ---------------------------------------------------------------------------
// 1. Quote
// ---------------------------------------------------------------------------
export async function quoteOrder(d: Deps, actor: PayActor, orderId: number): Promise<ResourceRow> {
  const { db, provider } = d;
  const order = loadOrder(db, orderId);
  assertBuyerOwns(actor, order);
  if (order.status !== "AWAITING_PAYMENT") throw new PaymentError("This order is not waiting for payment");
  const cur = latestResource(db, orderId);
  if (cur && (cur.state === "SUBMITTED" || cur.state === "UNKNOWN")) throw new PaymentError("A payment is already in progress or needs checking. Use Check payment status.");
  if (cur && (cur.state === "CREATED" || cur.state === "AWAITING_CONSENT") && cur.quote_expires_at && Date.parse(cur.quote_expires_at) - nowMs(d) > MIN_QUOTE_MS) {
    throw new PaymentError("You already have a valid quote");
  }

  const buyerRow = wallet(db, order.buyer_wallet_id);
  const coopRow = wallet(db, order.cooperative_wallet_id);
  let buyer: WalletInfo, coop: WalletInfo;
  try {
    [buyer, coop] = await Promise.all([provider.getWallet(buyerRow.canonical_url), provider.getWallet(coopRow.canonical_url)]);
  } catch (e) {
    throw failure(d, actor, "QUOTE_FAILED", orderId, "Could not look up the wallets", errMsg(e));
  }
  // Provider's real asset details must match what we stored, and the order must be in the cooperative's asset.
  if (buyer.assetCode !== buyerRow.asset_code || buyer.assetScale !== buyerRow.asset_scale || coop.assetCode !== coopRow.asset_code || coop.assetScale !== coopRow.asset_scale ||
      coop.assetCode !== order.asset_code || coop.assetScale !== order.asset_scale) {
    throw failure(d, actor, "QUOTE_FAILED", orderId, "Wallet asset does not match what we expect", `buyer ${buyer.assetCode}/${buyer.assetScale} coop ${coop.assetCode}/${coop.assetScale}`);
  }
  db.prepare("UPDATE wallets SET verified_at = ? WHERE id IN (?, ?)").run(iso(nowMs(d)), buyerRow.id, coopRow.id);

  const expected = order.expected_receive_minor;
  try {
    // Reuse a still-valid, untouched incoming payment; otherwise create a fresh one for the fixed amount.
    const prev = db
      .prepare("SELECT incoming_payment_id, incoming_expires_at, incoming_completed, received_minor FROM payment_resources WHERE order_id = ? AND direction='INBOUND' AND incoming_payment_id IS NOT NULL ORDER BY id DESC LIMIT 1")
      .get(orderId) as { incoming_payment_id: string; incoming_expires_at: string | null; incoming_completed: number | null; received_minor: number | null } | undefined;
    const reusable = prev && !prev.incoming_completed && !prev.received_minor && prev.incoming_expires_at && Date.parse(prev.incoming_expires_at) - nowMs(d) > 15 * 60_000;
    let incomingId: string, incomingExpires: string | undefined;
    if (reusable) {
      incomingId = prev!.incoming_payment_id;
      incomingExpires = prev!.incoming_expires_at!;
    } else {
      const inc = await provider.createIncomingPayment({ coop, amount: amt(expected, order.asset_code, order.asset_scale), expiresAt: iso(nowMs(d) + INCOMING_VALID_MS) });
      incomingId = inc.id;
      incomingExpires = inc.expiresAt ?? iso(nowMs(d) + INCOMING_VALID_MS);
    }
    const q = await provider.createQuote({ buyer, incomingId });
    if (minorOf(q.receiveAmount) !== expected || q.receiveAmount.assetCode !== order.asset_code || q.receiveAmount.assetScale !== order.asset_scale) {
      throw new Error(`Quote receive amount ${q.receiveAmount.value} ${q.receiveAmount.assetCode} does not match the order`);
    }
    const expiresAt = q.expiresAt ?? iso(nowMs(d) + FALLBACK_QUOTE_MS);
    const id = Number(
      db
        .prepare(
          `INSERT INTO payment_resources (order_id, direction, incoming_payment_id, quote_id, quote_debit_minor, quote_debit_asset, quote_debit_scale,
             receive_minor, receive_asset, receive_scale, state, buyer_wallet_id, quote_expires_at, incoming_expires_at, updated_at)
           VALUES (?, 'INBOUND', ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?, ?)`,
        )
        .run(orderId, incomingId, q.id, minorOf(q.debitAmount), q.debitAmount.assetCode, q.debitAmount.assetScale, minorOf(q.receiveAmount), q.receiveAmount.assetCode, q.receiveAmount.assetScale,
          buyerRow.id, expiresAt, incomingExpires, iso(nowMs(d))).lastInsertRowid,
    );
    audit(db, {
      actor: who(actor), action: "QUOTE_CREATED", entityType: "order", entityId: orderId,
      metadata: { paymentResourceId: id, quoteId: q.id, incomingPaymentId: incomingId, reusedIncoming: !!reusable, debit: q.debitAmount, receive: q.receiveAmount, expiresAt, expirySource: q.expiresAt ? "provider" : "fallback" },
    });
    return resourceById(db, id);
  } catch (e) {
    throw failure(d, actor, "QUOTE_FAILED", orderId, "Could not create the quote", errMsg(e));
  }
}

// ---------------------------------------------------------------------------
// 2. Start consent
// ---------------------------------------------------------------------------
export async function startAuthorization(d: Deps, actor: PayActor, orderId: number): Promise<{ redirectUrl: string }> {
  const { db, provider } = d;
  const order = loadOrder(db, orderId);
  assertBuyerOwns(actor, order);
  if (order.status !== "AWAITING_PAYMENT") throw new PaymentError("This order is not waiting for payment");
  const cur = latestResource(db, orderId);
  if (!cur || !cur.quote_id || (cur.state !== "CREATED" && cur.state !== "AWAITING_CONSENT")) throw new PaymentError("Get a quote first");
  if (!cur.quote_expires_at || Date.parse(cur.quote_expires_at) - nowMs(d) < MIN_QUOTE_MS) throw new PaymentError("The quote has expired. Get a new quote.");

  const buyerRow = wallet(db, order.buyer_wallet_id);
  const nonce = randomUUID();
  const reference = randomUUID();
  const finishUri = `${d.appBaseUrl.replace(/\/$/, "")}/api/payments/callback?gs=${reference}&order=${orderId}&purpose=${PURPOSE}`;
  let pending;
  let buyer: WalletInfo;
  try {
    buyer = await provider.getWallet(buyerRow.canonical_url);
    pending = await provider.startOutgoingGrant({
      buyer,
      debit: amt(cur.quote_debit_minor!, cur.quote_debit_asset!, cur.quote_debit_scale!),
      finishUri,
      nonce,
    });
  } catch (e) {
    throw failure(d, actor, "CONSENT_START_FAILED", orderId, "Could not start the wallet authorization", errMsg(e));
  }

  db.transaction(() => {
    // Only the newest consent session can be used: retire older unused ones for this payment.
    db.prepare("UPDATE grant_sessions SET outcome = 'EXPIRED', used_at = ? WHERE payment_resource_id = ? AND used_at IS NULL").run(iso(nowMs(d)), cur.id);
    db.prepare(
      `INSERT INTO grant_sessions (initiator_session_id, wallet_id, order_id, nonce, grant_reference, expires_at, purpose, payment_resource_id,
         server_nonce, grant_endpoint, continue_uri, continue_token_enc)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(actor.sessionId, buyerRow.id, orderId, nonce, reference, iso(nowMs(d) + GRANT_SESSION_MS), PURPOSE, cur.id, pending.serverNonce, buyer.authServer, pending.continueUri, seal(pending.continueToken));
    const next = cur.state === "CREATED" ? transition("CREATED", "AWAITING_CONSENT") : cur.state;
    db.prepare("UPDATE payment_resources SET state = ?, consent_outcome = NULL, updated_at = ? WHERE id = ?").run(next, iso(nowMs(d)), cur.id);
    audit(db, { actor: who(actor), action: "CONSENT_STARTED", entityType: "order", entityId: orderId, metadata: { paymentResourceId: cur.id, grantReference: reference, purpose: PURPOSE } });
  })();
  return { redirectUrl: pending.redirectUrl };
}

// ---------------------------------------------------------------------------
// 3. Callback
// ---------------------------------------------------------------------------

/**
 * Official hash check (same as spike/pay.ts): SHA-256 of
 * clientNonce \n serverNonce \n interact_ref \n grantEndpointUri, base64. Compared in a normalised
 * form (no '=' padding, url-safe characters mapped to standard) because the docs show both.
 */
export function verifyInteractionHash(p: { clientNonce: string; serverNonce: string; interactRef: string; grantEndpoint: string; receivedHash: string }): boolean {
  const base = `${p.clientNonce}\n${p.serverNonce}\n${p.interactRef}\n${p.grantEndpoint}`;
  const norm = (s: string) => s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  return norm(createHash("sha256").update(base).digest("base64")) === norm(p.receivedHash);
}

export type CallbackResult = { kind: "PROCESSING" | "CANCELLED" | "REJECTED"; orderId: number | null; message: string; auditId?: number };

export async function handleCallback(d: Deps, actor: PayActor | null, q: URLSearchParams): Promise<CallbackResult> {
  const { db, provider } = d;
  const reject = (reason: string, gs: GrantRow | null, outcome: "ERROR" | "EXPIRED" | null = null): CallbackResult => {
    if (gs && outcome) db.prepare("UPDATE grant_sessions SET outcome = ? WHERE id = ? AND outcome IS NULL").run(outcome, gs.id);
    const auditId = audit(db, {
      actor: actor ? who(actor) : "anonymous", action: "GRANT_REJECTED", entityType: gs ? "order" : "callback", entityId: gs ? gs.order_id : "n/a",
      metadata: { reason, grantSessionId: gs?.id ?? null, message: "Callback rejected" },
    });
    return { kind: "REJECTED", orderId: gs?.order_id ?? null, message: "This payment return was rejected.", auditId };
  };

  if (!actor) return reject("NO_SESSION", null);

  // Find the consent session: by our reference in the return URL, else the newest unused one for this login session.
  const ref = q.get("gs");
  const gs = (ref
    ? db.prepare("SELECT * FROM grant_sessions WHERE grant_reference = ?").get(ref)
    : db.prepare("SELECT * FROM grant_sessions WHERE initiator_session_id = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1").get(actor.sessionId)) as GrantRow | undefined;
  if (!gs) return reject("UNKNOWN_GRANT_SESSION", null);
  if (gs.initiator_session_id !== actor.sessionId) return reject("WRONG_SESSION", gs);
  const order = loadOrder(db, gs.order_id);
  if (order.buyer_user_id !== actor.id || actor.role !== "buyer") return reject("WRONG_USER", gs);
  if (q.has("order") && q.get("order") !== String(gs.order_id)) return reject("ORDER_MISMATCH", gs);
  if (q.has("purpose") && q.get("purpose") !== gs.purpose) return reject("PURPOSE_MISMATCH", gs);
  if (gs.purpose !== PURPOSE) return reject("PURPOSE_MISMATCH", gs);
  if (gs.used_at) return reject("REPLAY", gs);
  if (Date.parse(gs.expires_at) < nowMs(d)) return reject("SESSION_EXPIRED", gs, "EXPIRED");

  // Replay prevention: mark used atomically. Only one request can win this update.
  const won = db.transaction(() => db.prepare("UPDATE grant_sessions SET used_at = ? WHERE id = ? AND used_at IS NULL").run(iso(nowMs(d)), gs.id).changes === 1)();
  if (!won) return reject("REPLAY", gs);

  const resource = gs.payment_resource_id ? resourceById(db, gs.payment_resource_id) : undefined;
  if (!resource) return reject("NO_PAYMENT_RESOURCE", gs, "ERROR");

  // The buyer declined in the wallet: a consent event, NOT a failed transfer.
  const result = q.get("result");
  if (result === "grant_rejected") {
    db.transaction(() => {
      db.prepare("UPDATE grant_sessions SET outcome = 'REJECTED' WHERE id = ?").run(gs.id);
      if (resource.state === "AWAITING_CONSENT") db.prepare("UPDATE payment_resources SET consent_outcome = 'REJECTED', updated_at = ? WHERE id = ?").run(iso(nowMs(d)), resource.id);
    })();
    const auditId = audit(db, {
      actor: who(actor), action: "CONSENT_REJECTED", entityType: "order", entityId: order.id,
      metadata: { outcome: "CANCELLED", paymentResourceId: resource.id, grantSessionId: gs.id },
    });
    return { kind: "CANCELLED", orderId: order.id, message: "You declined the payment in the wallet. Nothing was paid. You can try again.", auditId };
  }
  if (result) return reject(`PROVIDER_RESULT_${result}`.slice(0, 60), gs, "ERROR");

  const interactRef = q.get("interact_ref");
  const hash = q.get("hash");
  if (!interactRef || !hash) return reject("MISSING_INTERACT_PARAMS", gs, "ERROR");
  if (!gs.server_nonce || !gs.grant_endpoint || !gs.continue_uri || !gs.continue_token_enc) return reject("INCOMPLETE_GRANT_SESSION", gs, "ERROR");
  if (!verifyInteractionHash({ clientNonce: gs.nonce, serverNonce: gs.server_nonce, interactRef, grantEndpoint: gs.grant_endpoint, receivedHash: hash })) {
    return reject("HASH_MISMATCH", gs, "ERROR");
  }
  audit(db, { actor: who(actor), action: "GRANT_VERIFIED", entityType: "order", entityId: order.id, metadata: { grantSessionId: gs.id, paymentResourceId: resource.id } });

  if (resource.state !== "AWAITING_CONSENT") return reject(`PAYMENT_NOT_AWAITING_CONSENT_${resource.state}`, gs, "ERROR");

  // Continue the grant (no money moves yet).
  let accessToken: string;
  let buyer: WalletInfo;
  try {
    buyer = await provider.getWallet(wallet(db, gs.wallet_id).canonical_url);
    ({ accessToken } = await provider.finishOutgoingGrant({ continueUri: gs.continue_uri, continueToken: open(gs.continue_token_enc), interactRef }));
  } catch (e) {
    db.prepare("UPDATE grant_sessions SET outcome = 'ERROR' WHERE id = ?").run(gs.id);
    const auditId = audit(db, { actor: who(actor), action: "GRANT_CONTINUE_FAILED", entityType: "order", entityId: order.id, metadata: { message: errMsg(e) } });
    return { kind: "REJECTED", orderId: order.id, message: "The wallet approval could not be completed. Nothing was paid. You can try again.", auditId };
  }

  // Submit. From here on a timeout means we do NOT know what happened.
  db.prepare("UPDATE payment_resources SET state = ?, outgoing_token_enc = ?, updated_at = ? WHERE id = ?").run(transition("AWAITING_CONSENT", "SUBMITTED"), seal(accessToken), iso(nowMs(d)), resource.id);
  let outgoing: OutgoingInfo | null = null;
  let outcome: "OK" | "REJECTED" | "UNKNOWN" = "OK";
  let detail = "";
  try {
    outgoing = await provider.createOutgoingPayment({ buyer, accessToken, quoteId: resource.quote_id! });
  } catch (e) {
    outcome = e instanceof ProviderRejected ? "REJECTED" : "UNKNOWN";
    detail = errMsg(e);
  }

  let auditId: number;
  if (outgoing) {
    db.prepare("UPDATE payment_resources SET outgoing_payment_id = ?, outgoing_failed = ?, sent_minor = ?, sent_asset = ?, sent_scale = ?, updated_at = ? WHERE id = ?").run(
      outgoing.id, outgoing.failed ? 1 : 0, minorOf(outgoing.sentAmount), outgoing.sentAmount.assetCode, outgoing.sentAmount.assetScale, iso(nowMs(d)), resource.id,
    );
    db.prepare("UPDATE grant_sessions SET outcome = 'GRANTED' WHERE id = ?").run(gs.id);
    auditId = audit(db, { actor: who(actor), action: "OUTGOING_CREATED", entityType: "order", entityId: order.id, metadata: { paymentResourceId: resource.id, outgoingPaymentId: outgoing.id, debit: outgoing.debitAmount, receive: outgoing.receiveAmount } });
  } else if (outcome === "REJECTED") {
    // The provider clearly refused (e.g. quote expired during consent). Nothing was sent.
    db.prepare("UPDATE payment_resources SET state = ?, updated_at = ? WHERE id = ?").run(transition("SUBMITTED", "FAILED"), iso(nowMs(d)), resource.id);
    db.prepare("UPDATE grant_sessions SET outcome = 'ERROR' WHERE id = ?").run(gs.id);
    auditId = audit(db, { actor: who(actor), action: "OUTGOING_REJECTED", entityType: "order", entityId: order.id, metadata: { paymentResourceId: resource.id, message: detail } });
  } else {
    // Unclear reply: mark UNKNOWN. We reconcile below and NEVER blindly retry.
    db.prepare("UPDATE payment_resources SET state = ?, updated_at = ? WHERE id = ?").run(transition("SUBMITTED", "UNKNOWN"), iso(nowMs(d)), resource.id);
    db.prepare("UPDATE grant_sessions SET outcome = 'ERROR' WHERE id = ?").run(gs.id);
    auditId = audit(db, { actor: who(actor), action: "OUTGOING_UNKNOWN", entityType: "order", entityId: order.id, metadata: { paymentResourceId: resource.id, message: detail } });
  }

  // Reconcile straight away (also covers UNKNOWN).
  try {
    await reconcileOrder(d, `${who(actor)}(auto)`, order.id);
  } catch (e) {
    audit(db, { actor: who(actor), action: "RECONCILE_FAILED", entityType: "order", entityId: order.id, metadata: { message: errMsg(e) } });
  }

  if (outcome === "REJECTED") return { kind: "REJECTED", orderId: order.id, message: "The wallet refused the payment (for example the quote expired). Nothing was paid. Get a new quote.", auditId };
  return { kind: "PROCESSING", orderId: order.id, message: outcome === "UNKNOWN" ? "We could not confirm the payment yet. It needs checking." : "Payment submitted.", auditId };
}

// ---------------------------------------------------------------------------
// 4. Reconciliation (provider is the source of truth)
// ---------------------------------------------------------------------------
export type ReconcileSummary = { orderStatus: string; confirmedIncomingId: string | null; exceptions: string[]; waiting: boolean };

export async function reconcileOrder(d: Deps, actorLabel: string, orderId: number): Promise<ReconcileSummary> {
  const { db, provider } = d;
  const order = loadOrder(db, orderId);
  const rows = db.prepare("SELECT * FROM payment_resources WHERE order_id = ? AND direction = 'INBOUND' ORDER BY id").all(orderId) as ResourceRow[];
  const incomingIds = [...new Set(rows.map((r) => r.incoming_payment_id).filter((x): x is string => !!x))];
  const coopRow = wallet(db, order.cooperative_wallet_id);
  const coop = await provider.getWallet(coopRow.canonical_url);
  const buyerRow = wallet(db, order.buyer_wallet_id);

  // Read every incoming payment from the provider.
  const facts: IncomingFacts[] = [];
  for (const id of incomingIds) {
    let info = await provider.getIncomingPayment({ coop, id });
    let received = minorOf(info.receivedAmount);
    const assetMatches = info.receivedAmount.assetCode === order.asset_code && info.receivedAmount.assetScale === order.asset_scale;
    // Fully received but not marked completed: complete it so the result is final.
    if (assetMatches && received === order.expected_receive_minor && !info.completed) {
      try {
        info = await provider.completeIncomingPayment({ coop, id });
        received = minorOf(info.receivedAmount);
      } catch {
        /* leave as not completed; we will simply wait */
      }
    }
    const expired = !!info.expiresAt && Date.parse(info.expiresAt) < nowMs(d);
    facts.push({ id, receivedMinor: received, assetMatches, completed: info.completed, expired });
    db.prepare("UPDATE payment_resources SET incoming_completed = ?, received_minor = ?, received_asset = ?, received_scale = ?, incoming_expires_at = COALESCE(?, incoming_expires_at), updated_at = ? WHERE order_id = ? AND incoming_payment_id = ?").run(
      info.completed ? 1 : 0, received, info.receivedAmount.assetCode, info.receivedAmount.assetScale, info.expiresAt ?? null, iso(nowMs(d)), orderId, id,
    );
  }

  // Read each outgoing payment we created.
  for (const r of rows) {
    if (!r.outgoing_payment_id || !r.outgoing_token_enc) continue;
    try {
      const o = await provider.getOutgoingPayment({ buyer: await provider.getWallet(buyerRow.canonical_url), accessToken: open(r.outgoing_token_enc), id: r.outgoing_payment_id });
      db.prepare("UPDATE payment_resources SET outgoing_failed = ?, sent_minor = ?, sent_asset = ?, sent_scale = ?, updated_at = ? WHERE id = ?").run(
        o.failed ? 1 : 0, minorOf(o.sentAmount), o.sentAmount.assetCode, o.sentAmount.assetScale, iso(nowMs(d)), r.id,
      );
    } catch (e) {
      audit(db, { actor: actorLabel, action: "RECONCILE_OUTGOING_UNREADABLE", entityType: "order", entityId: orderId, metadata: { paymentResourceId: r.id, message: errMsg(e) } });
    }
  }

  const decision = evaluateReceipts(order.expected_receive_minor, facts, order.confirmed_incoming_id);

  db.transaction(() => {
    let confirmedId = order.confirmed_incoming_id;
    if (decision.confirmIncomingId && order.status === "AWAITING_PAYMENT" && order.confirmed_received_minor === null) {
      const res = db
        .prepare("UPDATE orders SET confirmed_received_minor = ?, status = 'RECEIVED', confirmed_incoming_id = ?, version = version + 1 WHERE id = ? AND status = 'AWAITING_PAYMENT' AND confirmed_received_minor IS NULL")
        .run(order.expected_receive_minor, decision.confirmIncomingId, orderId);
      if (res.changes === 1) {
        confirmedId = decision.confirmIncomingId;
        audit(db, { actor: actorLabel, action: "ORDER_RECEIVED", entityType: "order", entityId: orderId, metadata: { incomingPaymentId: confirmedId, confirmedReceivedMinor: order.expected_receive_minor } });
      }
    }

    // Move submitted / unknown payments to their real outcome (UNKNOWN needs this reconciliation).
    const fresh = db.prepare("SELECT * FROM payment_resources WHERE order_id = ? AND direction = 'INBOUND' ORDER BY id").all(orderId) as ResourceRow[];
    for (const r of fresh) {
      if (r.state !== "SUBMITTED" && r.state !== "UNKNOWN") continue;
      let to: PayoutState | null = null;
      if (r.outgoing_failed === 1) to = "FAILED";
      else if (confirmedId && r.incoming_payment_id === confirmedId) to = "CONFIRMED";
      if (to) {
        db.prepare("UPDATE payment_resources SET state = ?, updated_at = ? WHERE id = ?").run(transition(r.state, to, { reconciled: true }), iso(nowMs(d)), r.id);
      }
    }

    // Exceptions: write each one only once.
    let detail = order.exception_detail ?? "";
    let code = order.exception;
    for (const ex of decision.exceptions) {
      const line = `${ex.code}:${ex.incomingId}`;
      if (detail.split("\n").some((l) => l.startsWith(line))) continue;
      detail = detail ? `${detail}\n${line}:${ex.detail}` : `${line}:${ex.detail}`;
      code = ex.code;
      audit(db, { actor: actorLabel, action: "EXCEPTION", entityType: "order", entityId: orderId, metadata: { code: ex.code, incomingPaymentId: ex.incomingId, detail: ex.detail, orderBlocked: order.status === "AWAITING_PAYMENT" && !confirmedId } });
    }
    if (code !== order.exception) db.prepare("UPDATE orders SET exception = ?, exception_detail = ? WHERE id = ?").run(code, detail, orderId);

    audit(db, {
      actor: actorLabel, action: "RECONCILED", entityType: "order", entityId: orderId,
      metadata: { incoming: facts.map((f) => ({ id: f.id, receivedMinor: f.receivedMinor, completed: f.completed })), confirmedIncomingId: confirmedId, waiting: decision.waiting },
    });
  })();

  const after = loadOrder(db, orderId);
  return { orderStatus: after.status, confirmedIncomingId: after.confirmed_incoming_id, exceptions: decision.exceptions.map((e) => e.code), waiting: decision.waiting };
}

/** Entry point for the reconcile route: permission check, then reconcile. */
export async function reconcileForActor(d: Deps, actor: PayActor, orderId: number): Promise<ReconcileSummary> {
  assertCanReconcile(actor, loadOrder(d.db, orderId));
  try {
    return await reconcileOrder(d, who(actor), orderId);
  } catch (e) {
    throw failure(d, actor, "RECONCILE_FAILED", orderId, "Could not read the payment from the provider", errMsg(e));
  }
}

// ---------------------------------------------------------------------------
// 5. Read model for pages
// ---------------------------------------------------------------------------
export type PaymentView = {
  orderStatus: string;
  expectedText: string;
  buyerWalletUrl: string;
  buyerWalletVerifiedAt: string | null;
  hasQuote: boolean;
  quoteDebitText: string | null;
  quoteExpiresAt: string | null;
  quoteExpired: boolean;
  statusWords: string;
  consentRejected: boolean;
  canQuote: boolean;
  canAuthorize: boolean;
  canReconcile: boolean;
  /** Operator only. */
  operator?: {
    exception: string | null;
    exceptionDetail: string | null;
    resources: { id: number; state: string; words: string; incomingId: string | null; quoteId: string | null; outgoingId: string | null; debit: string | null; receive: string | null; received: string | null; sent: string | null; completed: boolean | null; outgoingFailed: boolean | null }[];
  };
};

export function getPaymentView(d: Deps, actor: PayActor, orderId: number): PaymentView {
  const { db } = d;
  const o = loadOrder(db, orderId);
  if (actor.role === "buyer") assertBuyerOwns(actor, o);
  else if (actor.role !== "operator") throw new ForbiddenError("Not allowed");
  const cur = latestResource(db, orderId);
  const bw = wallet(db, o.buyer_wallet_id);
  const m = (n: number | null, c: string | null, s: number | null) => (n === null || c === null || s === null ? null : formatMoney(n, c, s));
  const msLeft = cur?.quote_expires_at ? Date.parse(cur.quote_expires_at) - nowMs(d) : -1;
  const awaiting = o.status === "AWAITING_PAYMENT";
  const live = !!cur && (cur.state === "CREATED" || cur.state === "AWAITING_CONSENT");
  const quoteValid = live && msLeft >= MIN_QUOTE_MS;
  const words = o.status !== "AWAITING_PAYMENT" ? STATE_WORDS.CONFIRMED.buyer : cur ? STATE_WORDS[cur.state].buyer : "Not started";
  const view: PaymentView = {
    orderStatus: o.status,
    expectedText: formatMoney(o.expected_receive_minor, o.asset_code, o.asset_scale),
    buyerWalletUrl: bw.canonical_url,
    buyerWalletVerifiedAt: bw.verified_at,
    hasQuote: !!cur?.quote_id,
    quoteDebitText: cur ? m(cur.quote_debit_minor, cur.quote_debit_asset, cur.quote_debit_scale) : null,
    quoteExpiresAt: cur?.quote_expires_at ?? null,
    quoteExpired: !!cur && live && msLeft < MIN_QUOTE_MS,
    statusWords: words,
    consentRejected: !!cur && cur.consent_outcome === "REJECTED" && awaiting,
    canQuote: actor.role === "buyer" && awaiting && (!cur || cur.state === "FAILED" || (live && !quoteValid)),
    canAuthorize: actor.role === "buyer" && awaiting && quoteValid,
    canReconcile: awaiting ? !!cur && (cur.state === "SUBMITTED" || cur.state === "UNKNOWN") : false,
  };
  if (actor.role === "operator") {
    const rows = db.prepare("SELECT * FROM payment_resources WHERE order_id = ? AND direction='INBOUND' ORDER BY id").all(orderId) as ResourceRow[];
    view.canReconcile = awaiting && rows.length > 0;
    view.operator = {
      exception: o.exception,
      exceptionDetail: o.exception_detail,
      resources: rows.map((r) => ({
        id: r.id, state: r.state, words: STATE_WORDS[r.state].dashboard, incomingId: r.incoming_payment_id, quoteId: r.quote_id, outgoingId: r.outgoing_payment_id,
        debit: m(r.quote_debit_minor, r.quote_debit_asset, r.quote_debit_scale), receive: m(r.receive_minor, r.receive_asset, r.receive_scale),
        received: m(r.received_minor, r.received_asset, r.received_scale), sent: m(r.sent_minor, r.sent_asset, r.sent_scale),
        completed: r.incoming_completed === null ? null : r.incoming_completed === 1, outgoingFailed: r.outgoing_failed === null ? null : r.outgoing_failed === 1,
      })),
    };
  }
  return view;
}

/** Message text for a failure the user was redirected after. Only events about the user's own orders are readable. */
export function getFailureMessage(db: Db, actor: PayActor, auditId: number): string | null {
  const e = db.prepare("SELECT entity_id, metadata FROM audit_events WHERE id = ? AND entity_type = 'order'").get(auditId) as { entity_id: string; metadata: string } | undefined;
  if (!e) return null;
  if (actor.role === "buyer") {
    const o = db.prepare("SELECT buyer_user_id FROM orders WHERE id = ?").get(Number(e.entity_id)) as { buyer_user_id: number } | undefined;
    if (!o || o.buyer_user_id !== actor.id) return null;
  }
  const msg = (JSON.parse(e.metadata) as { message?: string; detail?: string }).message;
  return typeof msg === "string" ? msg : null;
}
