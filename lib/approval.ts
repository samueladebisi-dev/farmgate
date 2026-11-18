// Approve and lock the split. The approval is bound to a fingerprint of every input the operator reviewed;
// if any of them changes afterwards the approval is invalidated.
import { createHash } from "node:crypto";
import { ForbiddenError } from "./access";
import { audit } from "./audit";
import { formatMoney, assertAllocationMatchesReceived } from "./money";
import { assertPayeesVerified, isVerified, payeeWallets, type PayeeRow } from "./payees";
import { errMsg, iso, loadOrder, nowMs, PaymentError, who, type Deps, type OrderRow, type PayActor } from "./payments";
import type { Db } from "./db";

type AllocRow = { id: number; recipient: string; kind: "farmer" | "logistics" | "cooperative"; gross_minor: number; fee_minor: number; deduction_minor: number; net_minor: number; asset_code: string; asset_scale: number };

const allocations = (db: Db, orderId: number) => db.prepare("SELECT * FROM allocations WHERE order_id = ? ORDER BY id").all(orderId) as AllocRow[];

/** Hash of every input of the approval: amounts, recipients, payee wallets and their verification. DB-only, no network. */
export function computeApprovalFingerprint(db: Db, orderId: number): string {
  const o = loadOrder(db, orderId);
  const payload = {
    order: [o.id, o.expected_receive_minor, o.confirmed_received_minor, o.asset_code, o.asset_scale, o.confirmed_incoming_id],
    allocations: allocations(db, orderId).map((a) => [a.recipient, a.kind, a.gross_minor, a.fee_minor, a.deduction_minor, a.net_minor, a.asset_code, a.asset_scale]),
    payees: payeeWallets(db, orderId).map((w) => [w.owner, w.canonical_url, w.asset_code, w.asset_scale, w.public_name, w.verified_fingerprint]),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export type ReviewModel = {
  orderId: number;
  orderRef: string;
  status: string;
  version: number;
  fingerprint: string;
  receivedText: string;
  beneficiaries: { recipient: string; label: string; publicName: string | null; url: string; verified: boolean; verifiedAt: string | null; netText: string; netMinor: number; projectedDebitText: string }[];
  payoutsTotalText: string;
  retainedText: string;
  totalText: string;
  allocationMatchesReceived: boolean;
  payeesAllVerified: boolean;
  canApprove: boolean;
  blockers: string[];
  exception: string | null;
};

export function getReview(d: Deps, actor: PayActor, orderId: number): ReviewModel {
  if (actor.role !== "operator") throw new ForbiddenError("Only operators can review");
  const { db } = d;
  const o = loadOrder(db, orderId);
  const allocs = allocations(db, orderId);
  const payees = payeeWallets(db, orderId);
  const code = o.asset_code, scale = o.asset_scale;
  const total = allocs.reduce((s, a) => s + a.net_minor, 0);
  const retained = allocs.filter((a) => a.kind === "cooperative").reduce((s, a) => s + a.net_minor, 0);
  const payouts = total - retained;
  const blockers: string[] = [];
  if (o.status !== "RECEIVED") blockers.push(o.status === "AWAITING_PAYMENT" ? "The buyer payment is not confirmed by the provider yet." : `Order is ${o.status}, only a RECEIVED order can be approved.`);
  if (o.confirmed_received_minor === null) blockers.push("No provider-confirmed received amount.");
  const matches = o.confirmed_received_minor !== null && total === o.confirmed_received_minor;
  if (o.confirmed_received_minor !== null && !matches) blockers.push(`Allocations (${formatMoney(total, code, scale)}) do not equal the confirmed received amount.`);
  const verifiedAll = payees.length > 0 && payees.every(isVerified);
  if (!verifiedAll) blockers.push("All four payees must be verified first.");
  const byOwner = new Map(payees.map((w) => [w.owner, w]));
  return {
    orderId, orderRef: o.order_ref, status: o.status, version: o.version, fingerprint: computeApprovalFingerprint(db, orderId),
    receivedText: o.confirmed_received_minor === null ? "Not confirmed" : formatMoney(o.confirmed_received_minor, code, scale),
    beneficiaries: allocs.filter((a) => a.kind !== "cooperative").map((a) => {
      const w = byOwner.get(a.recipient) as PayeeRow | undefined;
      return {
        recipient: a.recipient, label: a.kind === "logistics" ? "Logistics" : a.recipient.replace("farmer-", "Farmer ").toUpperCase().replace("FARMER ", "Farmer "),
        publicName: w?.verified_public_name ?? null, url: w?.canonical_url ?? "(no wallet)", verified: !!w && isVerified(w), verifiedAt: w?.verified_at ?? null,
        netText: formatMoney(a.net_minor, a.asset_code, a.asset_scale), netMinor: a.net_minor,
        // Same asset on both sides, so the projected debit is the net amount; the real quote replaces it later.
        projectedDebitText: formatMoney(a.net_minor, a.asset_code, a.asset_scale),
      };
    }),
    payoutsTotalText: formatMoney(payouts, code, scale), retainedText: formatMoney(retained, code, scale), totalText: formatMoney(total, code, scale),
    allocationMatchesReceived: matches, payeesAllVerified: verifiedAll, canApprove: blockers.length === 0, blockers, exception: o.exception,
  };
}

/** Lock the split. `presentedFingerprint` is the review the operator actually looked at. */
export async function approveOrder(d: Deps, actor: PayActor, orderId: number, presentedFingerprint: string): Promise<void> {
  if (actor.role !== "operator") throw new ForbiddenError("Only operators can approve");
  const { db } = d;
  const o = loadOrder(db, orderId);
  if (o.status !== "RECEIVED" || o.confirmed_received_minor === null) throw new PaymentError("Only an order the provider has confirmed as received can be approved");
  const total = allocations(db, orderId).reduce((s, a) => s + a.net_minor, 0);
  try {
    assertAllocationMatchesReceived(total, o.confirmed_received_minor);
  } catch (e) {
    audit(db, { actor: who(actor), action: "APPROVAL_BLOCKED", entityType: "order", entityId: orderId, metadata: { reason: "ALLOCATION_MISMATCH", message: errMsg(e) } });
    throw new PaymentError(`Allocations do not match the confirmed received amount: ${errMsg(e)}`);
  }
  await assertPayeesVerified(d, orderId, who(actor));
  const fingerprint = computeApprovalFingerprint(db, orderId);
  if (fingerprint !== presentedFingerprint) {
    audit(db, { actor: who(actor), action: "APPROVAL_BLOCKED", entityType: "order", entityId: orderId, metadata: { reason: "REVIEW_STALE" } });
    throw new PaymentError("Something changed since you opened the review. Reload the review and check it again.");
  }
  db.transaction(() => {
    const version = o.approval_version + 1;
    const res = db
      .prepare("UPDATE orders SET status = 'APPROVED', approval_version = ?, approval_fingerprint = ?, approved_at = ?, version = version + 1 WHERE id = ? AND status = 'RECEIVED' AND version = ?")
      .run(version, fingerprint, iso(nowMs(d)), orderId, o.version);
    if (res.changes !== 1) throw new PaymentError("The order changed while approving. Reload and try again.");
    db.prepare("UPDATE allocations SET approval_version = ?, approved_by = ?, approved_at = ? WHERE order_id = ?").run(version, actor.id, iso(nowMs(d)), orderId);
    audit(db, { actor: who(actor), action: "SPLIT_APPROVED", entityType: "order", entityId: orderId, metadata: { approvalVersion: version, totalMinor: total, fingerprint: fingerprint.slice(0, 12) } });
  })();
}

/**
 * Call before any release step. If the inputs changed after approval, the approval is invalidated:
 * the order goes back to RECEIVED (when no payout has started) and the caller gets an error.
 */
export function assertApprovalIntact(d: Deps, actorLabel: string, orderId: number): OrderRow {
  const { db } = d;
  const o = loadOrder(db, orderId);
  if (o.status !== "APPROVED" && o.status !== "COMPLETED") throw new PaymentError("The split is not approved");
  if (o.approval_fingerprint && computeApprovalFingerprint(db, orderId) === o.approval_fingerprint) return o;
  const started = (db.prepare("SELECT COUNT(*) c FROM payout_operations WHERE order_id = ? AND state <> 'CREATED'").get(orderId) as { c: number }).c > 0;
  db.transaction(() => {
    if (!started) {
      db.prepare("UPDATE allocations SET approval_version = 0, approved_by = NULL, approved_at = NULL WHERE order_id = ?").run(orderId);
      db.prepare("UPDATE orders SET status = 'RECEIVED', approval_fingerprint = NULL, approved_at = NULL, version = version + 1 WHERE id = ?").run(orderId);
    }
    audit(db, { actor: actorLabel, action: "APPROVAL_INVALIDATED", entityType: "order", entityId: orderId, metadata: { reason: "INPUTS_CHANGED", payoutsAlreadyStarted: started } });
  })();
  throw new PaymentError(started ? "Approved inputs changed after payouts started. Release is blocked; operator review needed." : "The approved inputs changed, so the approval was removed. Review and approve again.");
}
