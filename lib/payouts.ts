// Payout orchestration (cooperative -> farmers and logistics). Every state change goes through lib/payout-state.ts.
// The provider is the source of truth: statuses only move on what the provider returned.
import { randomUUID } from "node:crypto";
import { ForbiddenError } from "./access";
import { assertApprovalIntact } from "./approval";
import { audit } from "./audit";
import type { Db } from "./db";
import { assertDebitsWithinReceived, formatMoney } from "./money";
import { assertPayeesVerified } from "./payees";
import {
  amt, errMsg, iso, loadOrder, minorOf, MIN_QUOTE_MS, nowMs, PaymentError, verifyCallback, who, wallet,
  type CallbackResult, type Deps, type OrderRow, type PayActor,
} from "./payments";
import { beginNewAttempt, STATE_WORDS, transition, type PayoutState } from "./payout-state";
import { ProviderRejected, type OutgoingInfo, type WalletInfo } from "./provider";
import { open, seal } from "./secretbox";

export const PAYOUT_PURPOSE = "PAYOUT";
const RESERVE_MINOR = 0; // required reserve, currently zero
const GRANT_SESSION_MS = 15 * 60_000;
const INCOMING_VALID_MS = 60 * 60_000;
const FALLBACK_QUOTE_MS = 5 * 60_000;

type OpRow = {
  id: number; allocation_id: number; approval_version: number; transfer_purpose: "FARMER_PAYOUT" | "LOGISTICS_PAYOUT"; idempotency_key: string;
  state: PayoutState; consent_outcome: "REJECTED" | null; order_id: number; recipient: string; net_minor: number; asset_code: string; asset_scale: number;
};
type AttemptRow = {
  id: number; operation_id: number; attempt_number: number; attempt_uuid: string | null; quote_id: string | null; outgoing_payment_id: string | null;
  quote_debit_minor: number | null; quote_debit_asset: string | null; quote_debit_scale: number | null; outcome: string | null;
  incoming_payment_id: string | null; incoming_expires_at: string | null; quote_expires_at: string | null; quote_claimed_at: string | null;
  receive_minor: number | null; received_minor: number | null; received_asset: string | null; received_scale: number | null; incoming_completed: number | null;
  sent_minor: number | null; sent_asset: string | null; sent_scale: number | null; outgoing_failed: number | null; grant_session_id: number | null; failure_message: string | null;
};
type GrantRow = { id: number; access_token_enc: string | null; scope: string | null; limit_minor: number | null };

const assertOperator = (a: PayActor) => {
  if (a.role !== "operator") throw new ForbiddenError("Only operators can manage payouts");
};
const opsFor = (db: Db, orderId: number, version: number) =>
  db.prepare("SELECT * FROM payout_operations WHERE order_id = ? AND approval_version = ? ORDER BY id").all(orderId, version) as OpRow[];
const opById = (db: Db, id: number) => {
  const o = db.prepare("SELECT * FROM payout_operations WHERE id = ?").get(id) as OpRow | undefined;
  if (!o) throw new PaymentError("Payout not found", undefined, 404);
  return o;
};
const currentAttempt = (db: Db, opId: number) =>
  db.prepare("SELECT * FROM payout_attempts WHERE operation_id = ? ORDER BY attempt_number DESC LIMIT 1").get(opId) as AttemptRow;
const walletByOwner = (db: Db, owner: string) =>
  db.prepare("SELECT id, canonical_url, asset_code, asset_scale, public_name FROM wallets WHERE owner = ?").get(owner) as { id: number; canonical_url: string; asset_code: string; asset_scale: number; public_name: string };

/** A recipient is blocked while any payout for the same allocation is SUBMITTED or UNKNOWN. */
function recipientBlocked(db: Db, op: OpRow): boolean {
  return !!db.prepare("SELECT 1 FROM payout_operations WHERE allocation_id = ? AND id <> ? AND state IN ('SUBMITTED','UNKNOWN')").get(op.allocation_id, op.id);
}

// ---------------------------------------------------------------------------
// Affordability
// ---------------------------------------------------------------------------

/** Debits already committed (submitted / unknown / confirmed) for this approval, excluding one operation. */
function committedDebits(db: Db, order: OrderRow, exceptOpId: number): number {
  const rows = db
    .prepare(
      `SELECT a.quote_debit_minor d FROM payout_operations p JOIN payout_attempts a ON a.operation_id = p.id
       WHERE p.order_id = ? AND p.approval_version = ? AND p.id <> ? AND p.state IN ('SUBMITTED','UNKNOWN','CONFIRMED')
         AND a.attempt_number = (SELECT MAX(attempt_number) FROM payout_attempts WHERE operation_id = p.id)`,
    )
    .all(order.id, order.approval_version, exceptOpId) as { d: number | null }[];
  return rows.reduce((s, r) => s + (r.d ?? 0), 0);
}

/** Sum of the CURRENT quoted debits of all non-failed payouts must fit inside confirmed received minus reserve. */
export function checkAffordability(d: Deps, order: OrderRow, label: string): { sumMinor: number } {
  const ops = opsFor(d.db, order.id, order.approval_version).filter((o) => o.state !== "FAILED");
  const debits = ops.map((o) => currentAttempt(d.db, o.id).quote_debit_minor ?? o.net_minor);
  try {
    assertDebitsWithinReceived(debits, order.confirmed_received_minor ?? 0, RESERVE_MINOR);
  } catch (e) {
    const sum = debits.reduce((s, x) => s + x, 0);
    audit(d.db, { actor: label, action: "PAYOUT_BLOCKED", entityType: "order", entityId: order.id, metadata: { reason: "INSUFFICIENT_FUNDS", quotedTotalMinor: sum, confirmedReceivedMinor: order.confirmed_received_minor, message: errMsg(e) } });
    throw new PaymentError(`Insufficient funds: quoted payouts total ${formatMoney(sum, order.asset_code, order.asset_scale)} but only ${formatMoney((order.confirmed_received_minor ?? 0) - RESERVE_MINOR, order.asset_code, order.asset_scale)} is confirmed received and available.`);
  }
  return { sumMinor: debits.reduce((s, x) => s + x, 0) };
}

// ---------------------------------------------------------------------------
// Create operations + quotes
// ---------------------------------------------------------------------------

/** Create the incoming payment (exact net amount) and the quote from the cooperative wallet for one attempt. */
async function quoteAttempt(d: Deps, actor: PayActor, order: OrderRow, op: OpRow, attempt: AttemptRow, mode: "claim" | "replace"): Promise<void> {
  const { db, provider } = d;
  if (mode === "claim") {
    const won = db.prepare("UPDATE payout_attempts SET quote_claimed_at = ? WHERE id = ? AND quote_id IS NULL AND quote_claimed_at IS NULL").run(iso(nowMs(d)), attempt.id).changes === 1;
    if (!won) return; // another request is already creating this quote
  }
  try {
    const receiverRow = walletByOwner(db, op.recipient);
    const coopRow = wallet(db, order.cooperative_wallet_id);
    const [receiver, coop] = await Promise.all([provider.getWallet(receiverRow.canonical_url), provider.getWallet(coopRow.canonical_url)]);
    if (receiver.assetCode !== order.asset_code || receiver.assetScale !== order.asset_scale || coop.assetCode !== order.asset_code || coop.assetScale !== order.asset_scale) {
      throw new Error(`Asset mismatch: payee ${receiver.assetCode}/${receiver.assetScale}, cooperative ${coop.assetCode}/${coop.assetScale}, order ${order.asset_code}/${order.asset_scale}`);
    }
    // Reuse the previous incoming payment only when it is still valid and nothing was received on it.
    const reuse = mode === "replace" && attempt.incoming_payment_id && attempt.incoming_expires_at && Date.parse(attempt.incoming_expires_at) - nowMs(d) > 15 * 60_000 && !attempt.incoming_completed && !attempt.received_minor;
    let incomingId: string, incomingExpires: string;
    if (reuse) {
      incomingId = attempt.incoming_payment_id!;
      incomingExpires = attempt.incoming_expires_at!;
    } else {
      const inc = await provider.createIncomingPayment({ coop: receiver, amount: amt(op.net_minor, op.asset_code, op.asset_scale), expiresAt: iso(nowMs(d) + INCOMING_VALID_MS) });
      incomingId = inc.id;
      incomingExpires = inc.expiresAt ?? iso(nowMs(d) + INCOMING_VALID_MS);
    }
    const q = await provider.createQuote({ buyer: coop, incomingId });
    if (minorOf(q.receiveAmount) !== op.net_minor || q.receiveAmount.assetCode !== op.asset_code || q.receiveAmount.assetScale !== op.asset_scale) {
      throw new Error(`Quote receive amount ${q.receiveAmount.value} ${q.receiveAmount.assetCode} does not match the allocation`);
    }
    if (q.debitAmount.assetCode !== order.asset_code || q.debitAmount.assetScale !== order.asset_scale) {
      throw new Error(`Quote debit is in ${q.debitAmount.assetCode}/${q.debitAmount.assetScale}, expected ${order.asset_code}/${order.asset_scale}`);
    }
    const expiresAt = q.expiresAt ?? iso(nowMs(d) + FALLBACK_QUOTE_MS);
    const res = db
      .prepare(
        `UPDATE payout_attempts SET incoming_payment_id = ?, incoming_expires_at = ?, quote_id = ?, quote_expires_at = ?, quote_debit_minor = ?, quote_debit_asset = ?, quote_debit_scale = ?,
           receive_minor = ?, receive_asset = ?, receive_scale = ?, updated_at = ? WHERE id = ? AND outgoing_payment_id IS NULL`,
      )
      .run(incomingId, incomingExpires, q.id, expiresAt, minorOf(q.debitAmount), q.debitAmount.assetCode, q.debitAmount.assetScale, minorOf(q.receiveAmount), q.receiveAmount.assetCode, q.receiveAmount.assetScale, iso(nowMs(d)), attempt.id);
    if (res.changes !== 1) throw new Error("Attempt already has an outgoing payment; quote not replaced");
    audit(db, {
      actor: who(actor), action: mode === "replace" ? "PAYOUT_REQUOTED" : "PAYOUT_QUOTED", entityType: "order", entityId: order.id,
      metadata: { operationId: op.id, recipient: op.recipient, attemptNumber: attempt.attempt_number, quoteId: q.id, incomingPaymentId: incomingId, reusedIncoming: !!reuse, debit: q.debitAmount, receive: q.receiveAmount, previousDebitMinor: attempt.quote_debit_minor, expiresAt },
    });
  } catch (e) {
    if (mode === "claim") db.prepare("UPDATE payout_attempts SET quote_claimed_at = NULL WHERE id = ? AND quote_id IS NULL").run(attempt.id);
    audit(db, { actor: who(actor), action: "PAYOUT_QUOTE_FAILED", entityType: "order", entityId: order.id, metadata: { operationId: op.id, recipient: op.recipient, message: errMsg(e) } });
    throw new PaymentError(`Could not create the quote for ${walletByOwner(db, op.recipient).public_name}: ${errMsg(e)}`);
  }
}

/** Start payouts: one operation per recipient (idempotent), then incoming payment + quote for each. */
export async function startPayouts(d: Deps, actor: PayActor, orderId: number): Promise<{ created: number; quoted: number }> {
  assertOperator(actor);
  const { db } = d;
  const order = assertApprovalIntact(d, who(actor), orderId);
  if (order.status !== "APPROVED") throw new PaymentError("Payouts can only start for an approved order");
  await assertPayeesVerified(d, orderId, who(actor));
  const allocs = db.prepare("SELECT * FROM allocations WHERE order_id = ? AND kind IN ('farmer','logistics') AND approval_version = ? ORDER BY id").all(orderId, order.approval_version) as
    { id: number; recipient: string; kind: string; net_minor: number; asset_code: string; asset_scale: number }[];
  if (allocs.length === 0) throw new PaymentError("No approved allocations to pay");

  // One transaction. UNIQUE(allocation_id, approval_version, transfer_purpose) means a double click cannot create a second set.
  let created = 0;
  db.transaction(() => {
    const insOp = db.prepare(
      `INSERT OR IGNORE INTO payout_operations (allocation_id, approval_version, transfer_purpose, idempotency_key, state, order_id, recipient, net_minor, asset_code, asset_scale)
       VALUES (?,?,?,?, 'CREATED', ?,?,?,?,?)`,
    );
    const insAttempt = db.prepare("INSERT INTO payout_attempts (operation_id, attempt_number, attempt_uuid, updated_at) VALUES (?,1,?,?)");
    for (const a of allocs) {
      const r = insOp.run(a.id, order.approval_version, a.kind === "logistics" ? "LOGISTICS_PAYOUT" : "FARMER_PAYOUT", randomUUID(), orderId, a.recipient, a.net_minor, a.asset_code, a.asset_scale);
      if (r.changes === 1) {
        insAttempt.run(Number(r.lastInsertRowid), randomUUID(), iso(nowMs(d)));
        created++;
      }
    }
    if (created) audit(db, { actor: who(actor), action: "PAYOUTS_CREATED", entityType: "order", entityId: orderId, metadata: { approvalVersion: order.approval_version, operations: created } });
  })();

  let quoted = 0;
  const errors: string[] = [];
  for (const op of opsFor(db, orderId, order.approval_version)) {
    const att = currentAttempt(db, op.id);
    if (op.state !== "CREATED" || att.quote_id) continue;
    try {
      await quoteAttempt(d, actor, order, op, att, "claim");
      quoted++;
    } catch (e) {
      errors.push(errMsg(e));
    }
  }
  if (errors.length) throw new PaymentError(errors.join(" | "));
  try {
    checkAffordability(d, order, who(actor));
  } catch (e) {
    throw e; // shown to the operator; payouts stay unreleased
  }
  return { created, quoted };
}

/** Replace quotes that expired or changed. Nothing is released; the operator reviews and authorizes again. */
export async function requotePayouts(d: Deps, actor: PayActor, orderId: number): Promise<{ requoted: number }> {
  assertOperator(actor);
  const { db } = d;
  const order = assertApprovalIntact(d, who(actor), orderId);
  await assertPayeesVerified(d, orderId, who(actor));
  let requoted = 0;
  const errors: string[] = [];
  for (const op of opsFor(db, orderId, order.approval_version)) {
    if (op.state !== "CREATED" && op.state !== "AWAITING_CONSENT") continue;
    const att = currentAttempt(db, op.id);
    if (att.outgoing_payment_id) continue;
    try {
      await quoteAttempt(d, actor, order, op, att, att.quote_id ? "replace" : "claim");
      requoted++;
    } catch (e) {
      errors.push(errMsg(e));
    }
  }
  // Older consent sessions were for the old quotes: retire them.
  db.prepare(
    `UPDATE grant_sessions SET outcome = 'EXPIRED', used_at = ? WHERE purpose = 'PAYOUT' AND order_id = ? AND used_at IS NULL`,
  ).run(iso(nowMs(d)), orderId);
  if (errors.length) throw new PaymentError(errors.join(" | "));
  return { requoted };
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

/**
 * Start consent. scope ALL: ONE grant whose limit is the total of all quoted debits (the provider decides whether
 * it really covers several payments; see submit step). scope SINGLE: a grant for one payout only.
 */
export async function authorizePayouts(d: Deps, actor: PayActor, orderId: number, operationId?: number): Promise<{ redirectUrl: string; scope: "ALL" | "SINGLE" }> {
  assertOperator(actor);
  const { db, provider } = d;
  const order = assertApprovalIntact(d, who(actor), orderId);
  if (order.status !== "APPROVED") throw new PaymentError("Payouts can only be released for an approved order");
  await assertPayeesVerified(d, orderId, who(actor));

  const all = opsFor(db, orderId, order.approval_version);
  if (all.length === 0) throw new PaymentError("Start payouts first");
  const targets = all.filter((o) => (operationId ? o.id === operationId : true) && (o.state === "CREATED" || o.state === "AWAITING_CONSENT"));
  if (targets.length === 0) throw new PaymentError("Nothing is waiting for approval");
  for (const op of targets) {
    if (recipientBlocked(db, op)) throw new PaymentError(`${walletByOwner(db, op.recipient).public_name} has a payout that needs checking. Reconcile it first.`);
    const att = currentAttempt(db, op.id);
    if (!att.quote_id || !att.quote_expires_at) throw new PaymentError(`${walletByOwner(db, op.recipient).public_name} has no quote yet`);
    if (Date.parse(att.quote_expires_at) - nowMs(d) < MIN_QUOTE_MS) {
      audit(db, { actor: who(actor), action: "PAYOUT_BLOCKED", entityType: "order", entityId: orderId, metadata: { reason: "QUOTE_EXPIRED", operationId: op.id } });
      throw new PaymentError("A quote has expired or is about to. Re-quote the payouts and review them again.");
    }
  }
  checkAffordability(d, order, who(actor));

  const limit = targets.reduce((s, o) => s + (currentAttempt(db, o.id).quote_debit_minor ?? 0), 0);
  const coopRow = wallet(db, order.cooperative_wallet_id);
  const reference = randomUUID();
  const nonce = randomUUID();
  const finishUri = `${d.appBaseUrl.replace(/\/$/, "")}/api/payments/callback?gs=${reference}&order=${orderId}&purpose=${PAYOUT_PURPOSE}`;
  let coop: WalletInfo, pending;
  try {
    coop = await provider.getWallet(coopRow.canonical_url);
    pending = await provider.startOutgoingGrant({ buyer: coop, debit: amt(limit, order.asset_code, order.asset_scale), finishUri, nonce });
  } catch (e) {
    audit(db, { actor: who(actor), action: "CONSENT_START_FAILED", entityType: "order", entityId: orderId, metadata: { message: errMsg(e) } });
    throw new PaymentError(`Could not start the wallet authorization: ${errMsg(e)}`);
  }
  const scope = targets.length === all.length || !operationId ? "ALL" : "SINGLE";
  db.transaction(() => {
    // Only the newest consent session stays usable.
    db.prepare("UPDATE grant_sessions SET outcome = 'EXPIRED', used_at = ? WHERE purpose = 'PAYOUT' AND order_id = ? AND used_at IS NULL").run(iso(nowMs(d)), orderId);
    const gid = Number(
      db
        .prepare(
          `INSERT INTO grant_sessions (initiator_session_id, wallet_id, order_id, nonce, grant_reference, expires_at, purpose, server_nonce, grant_endpoint, continue_uri, continue_token_enc, scope, limit_minor)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(actor.sessionId, coopRow.id, orderId, nonce, reference, iso(nowMs(d) + GRANT_SESSION_MS), PAYOUT_PURPOSE, pending.serverNonce, coop.authServer, pending.continueUri, seal(pending.continueToken), scope, limit).lastInsertRowid,
    );
    for (const op of targets) {
      db.prepare("INSERT INTO grant_session_operations (grant_session_id, operation_id) VALUES (?,?)").run(gid, op.id);
      const next = op.state === "CREATED" ? transition("CREATED", "AWAITING_CONSENT") : op.state;
      db.prepare("UPDATE payout_operations SET state = ?, consent_outcome = NULL, updated_at = ? WHERE id = ? AND state IN ('CREATED','AWAITING_CONSENT')").run(next, iso(nowMs(d)), op.id);
    }
    audit(db, { actor: who(actor), action: "CONSENT_STARTED", entityType: "order", entityId: orderId, metadata: { purpose: PAYOUT_PURPOSE, scope, operationIds: targets.map((o) => o.id), limitMinor: limit, grantReference: reference } });
  })();
  return { redirectUrl: pending.redirectUrl, scope };
}

// ---------------------------------------------------------------------------
// Callback -> outgoing payments, one at a time
// ---------------------------------------------------------------------------

type SubmitResult = "created" | "failed" | "unknown" | "blocked" | "skipped" | "grant_limit";

async function submitOne(d: Deps, actor: PayActor, order: OrderRow, coop: WalletInfo, gsId: number, token: string, opId: number, createdUnderGrant: number): Promise<SubmitResult> {
  const { db, provider } = d;
  const op = opById(db, opId);
  const att = currentAttempt(db, op.id);
  const block = (reason: string, extra: Record<string, unknown> = {}): SubmitResult => {
    audit(db, { actor: who(actor), action: "PAYOUT_BLOCKED", entityType: "order", entityId: order.id, metadata: { reason, operationId: op.id, recipient: op.recipient, ...extra } });
    return "blocked";
  };
  if (op.state !== "AWAITING_CONSENT") return "skipped";
  if (recipientBlocked(db, op)) return block("RECIPIENT_NEEDS_CHECKING");
  if (!att.quote_id || !att.quote_expires_at || Date.parse(att.quote_expires_at) < nowMs(d)) return block("QUOTE_EXPIRED");
  // Funds: what is already committed plus this payout must fit inside confirmed received minus reserve.
  const debit = att.quote_debit_minor ?? 0;
  if (committedDebits(db, order, op.id) + debit > (order.confirmed_received_minor ?? 0) - RESERVE_MINOR) return block("INSUFFICIENT_FUNDS");

  // Compare-and-set claim of the right to submit: if two requests race, only one gets changes === 1.
  const next = transition("AWAITING_CONSENT", "SUBMITTED");
  const claimed = db.transaction(() => {
    const r = db.prepare("UPDATE payout_operations SET state = ?, consent_outcome = NULL, updated_at = ? WHERE id = ? AND state = 'AWAITING_CONSENT'").run(next, iso(nowMs(d)), op.id);
    if (r.changes !== 1) return false;
    db.prepare("UPDATE payout_attempts SET outcome = 'PENDING', grant_session_id = ?, updated_at = ? WHERE id = ?").run(gsId, iso(nowMs(d)), att.id);
    return true;
  })();
  if (!claimed) return "skipped";

  let outgoing: OutgoingInfo | null = null;
  let kind: "ok" | "rejected" | "unclear" = "ok";
  let detail = "";
  try {
    outgoing = await provider.createOutgoingPayment({ buyer: coop, accessToken: token, quoteId: att.quote_id });
  } catch (e) {
    kind = e instanceof ProviderRejected ? "rejected" : "unclear";
    detail = errMsg(e);
  }

  if (outgoing) {
    db.prepare("UPDATE payout_attempts SET outgoing_payment_id = ?, outgoing_failed = ?, sent_minor = ?, sent_asset = ?, sent_scale = ?, updated_at = ? WHERE id = ?").run(
      outgoing.id, outgoing.failed ? 1 : 0, minorOf(outgoing.sentAmount), outgoing.sentAmount.assetCode, outgoing.sentAmount.assetScale, iso(nowMs(d)), att.id,
    );
    audit(db, { actor: who(actor), action: "OUTGOING_CREATED", entityType: "order", entityId: order.id, metadata: { operationId: op.id, recipient: op.recipient, outgoingPaymentId: outgoing.id, debit: outgoing.debitAmount, receive: outgoing.receiveAmount } });
    return "created";
  }
  if (kind === "rejected") {
    db.transaction(() => {
      db.prepare("UPDATE payout_operations SET state = ?, updated_at = ? WHERE id = ?").run(transition("SUBMITTED", "FAILED"), iso(nowMs(d)), op.id);
      db.prepare("UPDATE payout_attempts SET outcome = 'FAILED', failure_message = ?, updated_at = ? WHERE id = ?").run(detail, iso(nowMs(d)), att.id);
    })();
    audit(db, { actor: who(actor), action: "OUTGOING_REJECTED", entityType: "order", entityId: order.id, metadata: { operationId: op.id, recipient: op.recipient, message: detail } });
    // A refusal on a LATER payment under the same consent, while the quote is still valid, means the consent did not cover it.
    return createdUnderGrant > 0 && Date.parse(att.quote_expires_at) > nowMs(d) ? "grant_limit" : "failed";
  }
  // Unclear reply after submitting: UNKNOWN. Reconciled by the caller; NEVER retried blindly.
  db.transaction(() => {
    db.prepare("UPDATE payout_operations SET state = ?, updated_at = ? WHERE id = ?").run(transition("SUBMITTED", "UNKNOWN"), iso(nowMs(d)), op.id);
    db.prepare("UPDATE payout_attempts SET outcome = 'UNKNOWN', failure_message = ?, updated_at = ? WHERE id = ?").run(detail, iso(nowMs(d)), att.id);
  })();
  audit(db, { actor: who(actor), action: "OUTGOING_UNKNOWN", entityType: "order", entityId: order.id, metadata: { operationId: op.id, recipient: op.recipient, message: detail } });
  return "unknown";
}

export async function handlePayoutCallback(d: Deps, actor: PayActor | null, q: URLSearchParams): Promise<CallbackResult> {
  const { db, provider } = d;
  const check = verifyCallback(d, actor, q, PAYOUT_PURPOSE);
  if (check.type === "reject") return check.result;
  if (!actor) throw new Error("unreachable: verifyCallback rejects a missing actor");
  const { gs, order } = check;
  const linked = (db.prepare("SELECT operation_id FROM grant_session_operations WHERE grant_session_id = ? ORDER BY operation_id").all(gs.id) as { operation_id: number }[]).map((r) => r.operation_id);

  if (check.type === "declined") {
    // Declined consent: an earlier cancelled consent, NOT a failed transfer. Payouts stay AWAITING_CONSENT.
    db.transaction(() => {
      db.prepare("UPDATE grant_sessions SET outcome = 'REJECTED' WHERE id = ?").run(gs.id);
      for (const id of linked) db.prepare("UPDATE payout_operations SET consent_outcome = 'REJECTED', updated_at = ? WHERE id = ? AND state = 'AWAITING_CONSENT'").run(iso(nowMs(d)), id);
    })();
    const auditId = audit(db, { actor: who(actor), action: "CONSENT_REJECTED", entityType: "order", entityId: order.id, metadata: { outcome: "CANCELLED", purpose: PAYOUT_PURPOSE, operationIds: linked, grantSessionId: gs.id } });
    return { kind: "CANCELLED", orderId: order.id, message: "Wallet approval was declined. Nothing was paid. You can authorize again.", auditId };
  }

  let token: string;
  let coop: WalletInfo;
  try {
    coop = await provider.getWallet(wallet(db, gs.wallet_id).canonical_url);
    ({ accessToken: token } = await provider.finishOutgoingGrant({ continueUri: gs.continue_uri!, continueToken: open(gs.continue_token_enc!), interactRef: check.interactRef }));
  } catch (e) {
    db.prepare("UPDATE grant_sessions SET outcome = 'ERROR' WHERE id = ?").run(gs.id);
    const auditId = audit(db, { actor: who(actor), action: "GRANT_CONTINUE_FAILED", entityType: "order", entityId: order.id, metadata: { purpose: PAYOUT_PURPOSE, message: errMsg(e) } });
    return { kind: "REJECTED", orderId: order.id, message: "The wallet approval could not be completed. Nothing was paid. You can authorize again.", auditId };
  }
  db.prepare("UPDATE grant_sessions SET outcome = 'GRANTED', access_token_enc = ? WHERE id = ?").run(seal(token), gs.id);

  // One payment at a time. The first clear refusal AFTER a success under the same consent = the consent does not cover more.
  const tally: Record<SubmitResult, number> = { created: 0, failed: 0, unknown: 0, blocked: 0, skipped: 0, grant_limit: 0 };
  let providerMessage: string | null = null;
  for (const id of linked) {
    const r = await submitOne(d, actor, order, coop, gs.id, token, id, tally.created);
    tally[r]++;
    if (r === "grant_limit") {
      providerMessage = currentAttempt(db, id).failure_message;
      break;
    }
  }
  const row = db.prepare("SELECT scope, limit_minor FROM grant_sessions WHERE id = ?").get(gs.id) as GrantRow;
  const auditId = audit(db, {
    actor: who(actor), action: "PAYOUT_SUBMIT_SUMMARY", entityType: "order", entityId: order.id,
    metadata: { grantScope: row.scope, grantLimitMinor: row.limit_minor, requested: linked.length, ...tally, grantDidNotCoverAll: tally.grant_limit > 0, providerMessage },
  });

  // Reconcile everything we touched straight away.
  for (const id of linked) {
    try {
      await reconcilePayoutInternal(d, `${who(actor)}(auto)`, id);
    } catch (e) {
      audit(db, { actor: who(actor), action: "RECONCILE_FAILED", entityType: "order", entityId: order.id, metadata: { operationId: id, message: errMsg(e) } });
    }
  }
  const parts = [`${tally.created} submitted`];
  if (tally.grant_limit) parts.push("the wallet approval did not cover the remaining payouts; approve each remaining payout separately");
  if (tally.blocked) parts.push(`${tally.blocked} blocked (see audit)`);
  if (tally.unknown) parts.push(`${tally.unknown} need checking`);
  if (tally.failed) parts.push(`${tally.failed} refused by the provider`);
  return { kind: "PROCESSING", orderId: order.id, message: parts.join("; "), auditId };
}

// ---------------------------------------------------------------------------
// Reconcile from the provider
// ---------------------------------------------------------------------------

async function reconcilePayoutInternal(d: Deps, label: string, opId: number): Promise<PayoutState> {
  const { db, provider } = d;
  const op = opById(db, opId);
  const order = loadOrder(db, op.order_id);
  const att = currentAttempt(db, op.id);
  const receiverRow = walletByOwner(db, op.recipient);
  const coopRow = wallet(db, order.cooperative_wallet_id);
  const receiver = await provider.getWallet(receiverRow.canonical_url);

  // Recipient's incoming payment: what the recipient really received.
  if (att.incoming_payment_id) {
    let inc = await provider.getIncomingPayment({ coop: receiver, id: att.incoming_payment_id });
    let received = minorOf(inc.receivedAmount);
    const same = inc.receivedAmount.assetCode === op.asset_code && inc.receivedAmount.assetScale === op.asset_scale;
    if (same && received === op.net_minor && !inc.completed) {
      try {
        inc = await provider.completeIncomingPayment({ coop: receiver, id: att.incoming_payment_id });
        received = minorOf(inc.receivedAmount);
      } catch {
        /* keep waiting */
      }
    }
    db.prepare("UPDATE payout_attempts SET incoming_completed = ?, received_minor = ?, received_asset = ?, received_scale = ?, incoming_expires_at = COALESCE(?, incoming_expires_at), updated_at = ? WHERE id = ?").run(
      inc.completed ? 1 : 0, received, inc.receivedAmount.assetCode, inc.receivedAmount.assetScale, inc.expiresAt ?? null, iso(nowMs(d)), att.id,
    );
  }
  // Our outgoing payment (needs the consent token stored with the grant).
  if (att.outgoing_payment_id && att.grant_session_id) {
    const g = db.prepare("SELECT access_token_enc FROM grant_sessions WHERE id = ?").get(att.grant_session_id) as { access_token_enc: string | null };
    if (g.access_token_enc) {
      try {
        const coop = await provider.getWallet(coopRow.canonical_url);
        const o = await provider.getOutgoingPayment({ buyer: coop, accessToken: open(g.access_token_enc), id: att.outgoing_payment_id });
        db.prepare("UPDATE payout_attempts SET outgoing_failed = ?, sent_minor = ?, sent_asset = ?, sent_scale = ?, updated_at = ? WHERE id = ?").run(
          o.failed ? 1 : 0, minorOf(o.sentAmount), o.sentAmount.assetCode, o.sentAmount.assetScale, iso(nowMs(d)), att.id,
        );
      } catch (e) {
        audit(db, { actor: label, action: "RECONCILE_OUTGOING_UNREADABLE", entityType: "order", entityId: order.id, metadata: { operationId: op.id, message: errMsg(e) } });
      }
    }
  }

  const fresh = currentAttempt(db, op.id);
  const cur = opById(db, op.id);
  let to: PayoutState | null = null;
  if (cur.state === "SUBMITTED" || cur.state === "UNKNOWN") {
    const exact = fresh.incoming_completed === 1 && fresh.received_minor === op.net_minor && fresh.received_asset === op.asset_code && fresh.received_scale === op.asset_scale;
    if (fresh.outgoing_failed === 1) to = "FAILED";
    else if (exact) to = "CONFIRMED";
    else if ((fresh.received_minor ?? 0) > 0 && fresh.incoming_completed === 1 && fresh.received_minor !== op.net_minor) {
      audit(db, { actor: label, action: "PAYOUT_EXCEPTION", entityType: "order", entityId: order.id, metadata: { operationId: op.id, recipient: op.recipient, expectedMinor: op.net_minor, receivedMinor: fresh.received_minor } });
    }
  }
  if (to) {
    db.transaction(() => {
      const r = db.prepare("UPDATE payout_operations SET state = ?, updated_at = ? WHERE id = ? AND state = ?").run(transition(cur.state, to!, { reconciled: true }), iso(nowMs(d)), op.id, cur.state);
      if (r.changes === 1) db.prepare("UPDATE payout_attempts SET outcome = ?, updated_at = ? WHERE id = ?").run(to === "CONFIRMED" ? "SUCCESS" : "FAILED", iso(nowMs(d)), fresh.id);
    })();
  }
  const final = opById(db, op.id);
  audit(db, {
    actor: label, action: "PAYOUT_RECONCILED", entityType: "order", entityId: order.id,
    metadata: { operationId: op.id, recipient: op.recipient, state: final.state, receivedMinor: fresh.received_minor, incomingCompleted: fresh.incoming_completed, outgoingFailed: fresh.outgoing_failed, sentMinor: fresh.sent_minor },
  });

  // All payouts confirmed -> the order is complete.
  const all = opsFor(db, order.id, order.approval_version);
  if (all.length > 0 && all.every((o) => o.state === "CONFIRMED")) {
    const r = db.prepare("UPDATE orders SET status = 'COMPLETED', version = version + 1 WHERE id = ? AND status = 'APPROVED'").run(order.id);
    if (r.changes === 1) audit(db, { actor: label, action: "ORDER_COMPLETED", entityType: "order", entityId: order.id, metadata: {} });
  }
  return final.state;
}

/** Operator action: re-read one payout from the provider. */
export async function reconcilePayout(d: Deps, actor: PayActor, opId: number): Promise<PayoutState> {
  assertOperator(actor);
  const op = opById(d.db, opId);
  try {
    return await reconcilePayoutInternal(d, who(actor), opId);
  } catch (e) {
    audit(d.db, { actor: who(actor), action: "RECONCILE_FAILED", entityType: "order", entityId: op.order_id, metadata: { operationId: opId, message: errMsg(e) } });
    throw new PaymentError(`Could not read the payout from the provider: ${errMsg(e)}`);
  }
}

// ---------------------------------------------------------------------------
// Retry (new attempt) - only after a provider-confirmed FAILED, only by an operator
// ---------------------------------------------------------------------------
export async function retryPayout(d: Deps, actor: PayActor, opId: number): Promise<void> {
  assertOperator(actor);
  const { db } = d;
  const op = opById(db, opId);
  const order = assertApprovalIntact(d, who(actor), op.order_id);
  const att = currentAttempt(db, op.id);
  // UNKNOWN / SUBMITTED / CONFIRMED all fail here: beginNewAttempt only accepts FAILED.
  const confirmedFailure = att.outcome === "FAILED";
  let start: PayoutState;
  try {
    start = beginNewAttempt(op.state, confirmedFailure);
  } catch (e) {
    audit(db, { actor: who(actor), action: "PAYOUT_RETRY_BLOCKED", entityType: "order", entityId: order.id, metadata: { operationId: op.id, state: op.state, message: errMsg(e) } });
    throw new PaymentError(`A new attempt is not allowed: ${errMsg(e)}`);
  }
  if (recipientBlocked(db, op)) throw new PaymentError("This recipient has another payout that needs checking first");
  await assertPayeesVerified(d, order.id, who(actor));
  const newAttemptId = db.transaction(() => {
    const r = db.prepare("UPDATE payout_operations SET state = ?, consent_outcome = NULL, updated_at = ? WHERE id = ? AND state = 'FAILED'").run(start, iso(nowMs(d)), op.id);
    if (r.changes !== 1) throw new PaymentError("The payout changed while starting a new attempt");
    const id = Number(db.prepare("INSERT INTO payout_attempts (operation_id, attempt_number, attempt_uuid, updated_at) VALUES (?,?,?,?)").run(op.id, att.attempt_number + 1, randomUUID(), iso(nowMs(d))).lastInsertRowid);
    audit(db, { actor: who(actor), action: "PAYOUT_RETRY_STARTED", entityType: "order", entityId: order.id, metadata: { operationId: op.id, recipient: op.recipient, attemptNumber: att.attempt_number + 1, previousFailure: att.failure_message } });
    return id;
  })();
  const attempt = db.prepare("SELECT * FROM payout_attempts WHERE id = ?").get(newAttemptId) as AttemptRow;
  await quoteAttempt(d, actor, order, opById(db, op.id), attempt, "claim");
}

// ---------------------------------------------------------------------------
// Read model for the operator dashboard
// ---------------------------------------------------------------------------
export type PayoutRow = {
  id: number; recipient: string; name: string; netText: string; state: PayoutState; words: string; consentRejected: boolean; attemptNumber: number;
  quoteDebitText: string | null; quoteExpiresAt: string | null; quoteExpired: boolean; receivedText: string | null; sentText: string | null;
  incomingId: string | null; quoteId: string | null; outgoingId: string | null; failureMessage: string | null;
  canAuthorize: boolean; canRetry: boolean; canReconcile: boolean; blocked: string | null;
};
export type PayoutView = {
  approvalVersion: number;
  rows: PayoutRow[];
  canStart: boolean;
  canRequote: boolean;
  canAuthorizeAll: boolean;
  projectedDebitText: string;
  actualDebitText: string;
  quotesComplete: boolean;
  affordability: string | null;
};

export function getPayoutView(d: Deps, actor: PayActor, orderId: number): PayoutView {
  assertOperator(actor);
  const { db } = d;
  const o = loadOrder(db, orderId);
  const code = o.asset_code, scale = o.asset_scale;
  const ops = opsFor(db, orderId, o.approval_version);
  const approved = o.status === "APPROVED";
  const m = (n: number | null, c: string | null, s: number | null) => (n === null || c === null || s === null ? null : formatMoney(n, c, s));
  const rows: PayoutRow[] = ops.map((op) => {
    const a = currentAttempt(db, op.id);
    const live = op.state === "CREATED" || op.state === "AWAITING_CONSENT";
    const left = a.quote_expires_at ? Date.parse(a.quote_expires_at) - nowMs(d) : -1;
    const blockedByOther = recipientBlocked(db, op);
    return {
      id: op.id, recipient: op.recipient, name: walletByOwner(db, op.recipient).public_name, netText: formatMoney(op.net_minor, op.asset_code, op.asset_scale),
      state: op.state, words: STATE_WORDS[op.state].dashboard, consentRejected: op.consent_outcome === "REJECTED", attemptNumber: a.attempt_number,
      quoteDebitText: m(a.quote_debit_minor, a.quote_debit_asset, a.quote_debit_scale), quoteExpiresAt: a.quote_expires_at, quoteExpired: live && !!a.quote_id && left < MIN_QUOTE_MS,
      receivedText: m(a.received_minor, a.received_asset, a.received_scale), sentText: m(a.sent_minor, a.sent_asset, a.sent_scale),
      incomingId: a.incoming_payment_id, quoteId: a.quote_id, outgoingId: a.outgoing_payment_id, failureMessage: a.failure_message,
      canAuthorize: approved && live && !!a.quote_id && left >= MIN_QUOTE_MS && !blockedByOther,
      canRetry: approved && op.state === "FAILED" && a.outcome === "FAILED" && !blockedByOther,
      canReconcile: op.state === "SUBMITTED" || op.state === "UNKNOWN",
      blocked: op.state === "UNKNOWN" ? "Needs checking: reconcile before anything else" : blockedByOther ? "Another payout for this recipient needs checking" : null,
    };
  });
  const quotesComplete = rows.length > 0 && rows.every((r) => r.quoteId || r.state === "FAILED");
  const projected = ops.reduce((s, op) => {
    if (op.state === "FAILED") return s;
    return s + (currentAttempt(db, op.id).quote_debit_minor ?? op.net_minor);
  }, 0);
  // Actual = what the provider says we really sent, for payouts the provider confirmed.
  const actual = ops.filter((op) => op.state === "CONFIRMED").reduce((s, op) => s + (currentAttempt(db, op.id).sent_minor ?? 0), 0);
  let affordability: string | null = null;
  try {
    if (approved && ops.length) {
      assertDebitsWithinReceived(ops.filter((x) => x.state !== "FAILED").map((x) => currentAttempt(db, x.id).quote_debit_minor ?? x.net_minor), o.confirmed_received_minor ?? 0, RESERVE_MINOR);
    }
  } catch {
    affordability = "Insufficient funds: quoted payouts exceed the confirmed received amount. Release is blocked.";
  }
  const live = rows.filter((r) => r.state === "CREATED" || r.state === "AWAITING_CONSENT");
  return {
    approvalVersion: o.approval_version, rows, canStart: approved && ops.length === 0,
    canRequote: approved && live.length > 0,
    canAuthorizeAll: approved && live.length > 0 && live.every((r) => r.canAuthorize) && !affordability,
    projectedDebitText: formatMoney(projected, code, scale), actualDebitText: formatMoney(actual, code, scale), quotesComplete, affordability,
  };
}
