// Operator-facing audit list: readable labels, and consent rejections described as what they are.
import { ForbiddenError } from "./access";
import type { Db } from "./db";
import type { PayActor } from "./payments";

const LABELS: Record<string, string> = {
  CONSENT_REJECTED: "Earlier consent cancelled in the wallet (not a failed transfer)",
  CONSENT_STARTED: "Wallet consent started",
  GRANT_VERIFIED: "Wallet return verified",
  GRANT_REJECTED: "Wallet return rejected",
  GRANT_CONTINUE_FAILED: "Wallet approval could not be completed (nothing paid)",
  QUOTE_CREATED: "Quote created",
  OUTGOING_CREATED: "Outgoing payment created at the provider",
  OUTGOING_REJECTED: "Provider refused the outgoing payment",
  OUTGOING_UNKNOWN: "Outgoing payment outcome unclear (needs checking)",
  RECONCILED: "Buyer payment reconciled with provider",
  ORDER_RECEIVED: "Order marked received (provider confirmed)",
  EXCEPTION: "Exception recorded",
  PAYEE_VERIFIED: "Payee verified",
  PAYEE_VERIFICATION_FAILED: "Payee verification failed or removed",
  SPLIT_APPROVED: "Split approved and locked",
  APPROVAL_BLOCKED: "Approval blocked",
  APPROVAL_INVALIDATED: "Approval invalidated (inputs changed)",
  PAYOUTS_CREATED: "Payout operations created",
  PAYOUT_QUOTED: "Payout quote created",
  PAYOUT_REQUOTED: "Payout quote replaced",
  PAYOUT_QUOTE_FAILED: "Payout quote failed",
  PAYOUT_BLOCKED: "Payout blocked",
  PAYOUT_SUBMIT_SUMMARY: "Payout submission summary",
  PAYOUT_RECONCILED: "Payout reconciled with provider",
  PAYOUT_EXCEPTION: "Payout exception",
  PAYOUT_RETRY_STARTED: "New payout attempt started by operator",
  PAYOUT_RETRY_BLOCKED: "New payout attempt refused",
  ORDER_COMPLETED: "All payouts confirmed, order completed",
  RECONCILE_FAILED: "Could not read from provider",
  RECONCILE_OUTGOING_UNREADABLE: "Outgoing payment could not be read",
};

export type AuditLine = { id: number; at: string; actor: string; action: string; label: string; detail: string };

/** Short, already-redacted detail text. Only a few well-known keys are shown. */
function detailOf(metadata: string): string {
  let m: Record<string, unknown> = {};
  try {
    m = JSON.parse(metadata);
  } catch {
    return "";
  }
  const keys = ["reason", "message", "outcome", "code", "recipient", "wallet", "scope", "operationIds", "state", "grantDidNotCoverAll", "created", "limitMinor", "providerMessage"];
  return keys
    .filter((k) => m[k] !== undefined && m[k] !== null)
    .map((k) => `${k}: ${typeof m[k] === "object" ? JSON.stringify(m[k]) : String(m[k])}`)
    .join(", ")
    .slice(0, 220);
}

export function getAuditView(db: Db, actor: PayActor, orderId: number, limit = 80): AuditLine[] {
  if (actor.role !== "operator") throw new ForbiddenError("Only operators can read the audit log");
  const rows = db.prepare("SELECT id, at, actor, action, metadata FROM audit_events WHERE entity_type = 'order' AND entity_id = ? ORDER BY id DESC LIMIT ?").all(String(orderId), limit) as
    { id: number; at: string; actor: string; action: string; metadata: string }[];
  return rows.map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, label: LABELS[r.action] ?? r.action, detail: detailOf(r.metadata) }));
}
