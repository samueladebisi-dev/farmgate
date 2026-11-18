// Shareable receipt links. The link shows ONE recipient's receipt, needs no login, expires within 24 hours and can be revoked.
// The token is random and unguessable (256 bits). Only its SHA-256 hash is stored, so a database leak cannot reveal links.
import { createHash, randomBytes } from "node:crypto";
import { ForbiddenError, NotFoundError } from "./access";
import { audit } from "./audit";
import type { Db } from "./db";
import { loadReceipt, type Receipt } from "./receipt";

export const LINK_MAX_HOURS = 24;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/; // base64url of 32 random bytes

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

const who = (a: { role: string; id: number }) => `${a.role}:${a.id}`;
type Operator = { id: number; role: string };
const assertOperator = (a: Operator) => {
  if (a.role !== "operator") throw new ForbiddenError("Only operators can manage receipt links");
};

export type CreatedLink = { id: number; token: string; url: string; expiresAt: string; hours: number };

/** Create a link for ONE recipient of one order. The plain token is returned once and never stored. */
export function createReceiptLink(db: Db, appBaseUrl: string, actor: Operator, orderId: number, allocationId: number, hoursRequested = LINK_MAX_HOURS, now = Date.now()): CreatedLink {
  assertOperator(actor);
  const alloc = db.prepare("SELECT id, kind FROM allocations WHERE id = ? AND order_id = ?").get(allocationId, orderId) as { id: number; kind: string } | undefined;
  if (!alloc) throw new NotFoundError("Recipient not found on this order");
  if (alloc.kind === "cooperative") throw new NotFoundError("The cooperative's retained amount has no recipient receipt");
  const hours = Math.min(LINK_MAX_HOURS, Math.max(1, Math.floor(Number.isFinite(hoursRequested) ? hoursRequested : LINK_MAX_HOURS)));
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now + hours * 3_600_000).toISOString();
  const id = Number(
    db.prepare("INSERT INTO receipt_links (token_hash, order_id, allocation_id, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?)").run(hashToken(token), orderId, allocationId, actor.id, new Date(now).toISOString(), expiresAt).lastInsertRowid,
  );
  // The audit row records that a link exists, never the token.
  audit(db, { actor: who(actor), action: "RECEIPT_LINK_CREATED", entityType: "order", entityId: orderId, metadata: { linkId: id, allocationId, expiresAt, hours } });
  return { id, token, url: `${appBaseUrl.replace(/\/$/, "")}/r/${token}`, expiresAt, hours };
}

export function revokeReceiptLink(db: Db, actor: Operator, linkId: number, now = Date.now()): void {
  assertOperator(actor);
  const l = db.prepare("SELECT id, order_id, revoked_at FROM receipt_links WHERE id = ?").get(linkId) as { id: number; order_id: number; revoked_at: string | null } | undefined;
  if (!l) throw new NotFoundError("Link not found");
  if (l.revoked_at) return; // already revoked
  db.prepare("UPDATE receipt_links SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL").run(new Date(now).toISOString(), actor.id, linkId);
  audit(db, { actor: who(actor), action: "RECEIPT_LINK_REVOKED", entityType: "order", entityId: l.order_id, metadata: { linkId } });
}

export type LinkRow = { id: number; allocationId: number; recipientName: string; createdAt: string; expiresAt: string; status: "ACTIVE" | "EXPIRED" | "REVOKED"; viewCount: number };

/** Operator list. The token is not recoverable, so only metadata is listed. */
export function listReceiptLinks(db: Db, actor: Operator, orderId: number, now = Date.now()): LinkRow[] {
  assertOperator(actor);
  const rows = db
    .prepare(
      `SELECT l.id, l.allocation_id, l.created_at, l.expires_at, l.revoked_at, l.view_count, w.public_name
       FROM receipt_links l JOIN allocations a ON a.id = l.allocation_id LEFT JOIN wallets w ON w.owner = a.recipient
       WHERE l.order_id = ? ORDER BY l.id DESC`,
    )
    .all(orderId) as { id: number; allocation_id: number; created_at: string; expires_at: string; revoked_at: string | null; view_count: number; public_name: string | null }[];
  return rows.map((r) => ({
    id: r.id, allocationId: r.allocation_id, recipientName: r.public_name ?? "Recipient", createdAt: r.created_at, expiresAt: r.expires_at, viewCount: r.view_count,
    status: r.revoked_at ? "REVOKED" : Date.parse(r.expires_at) <= now ? "EXPIRED" : "ACTIVE",
  }));
}

export type Resolved = { ok: true; receipt: Receipt; expiresAt: string } | { ok: false };

/**
 * Public lookup. The answer for a bad, unknown, expired or revoked link is identical (`ok: false`),
 * so nobody can learn which case it was. Expiry and revocation are decided here, on the server, on every view.
 */
export function resolveReceiptLink(db: Db, token: string, now = Date.now()): Resolved {
  if (typeof token !== "string" || !TOKEN_SHAPE.test(token)) return { ok: false };
  const l = db.prepare("SELECT id, allocation_id, expires_at, revoked_at FROM receipt_links WHERE token_hash = ?").get(hashToken(token)) as
    | { id: number; allocation_id: number; expires_at: string; revoked_at: string | null }
    | undefined;
  if (!l || l.revoked_at || Date.parse(l.expires_at) <= now) return { ok: false };
  // Only the link's own allocation is ever loaded: there is no way to ask for another recipient.
  const receipt = loadReceipt(db, l.allocation_id);
  if (!receipt) return { ok: false };
  db.prepare("UPDATE receipt_links SET view_count = view_count + 1, last_viewed_at = ? WHERE id = ?").run(new Date(now).toISOString(), l.id);
  return { ok: true, receipt, expiresAt: l.expires_at };
}
