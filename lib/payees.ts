// Payee verification: farmers A/B/C and logistics must be verified by an operator before money can be split.
// Verification = strict URL allow-list (before any network call) + provider lookup + canonical URL and asset checks.
// Public name is shown for review but is NOT proof of identity.
import { createHash } from "node:crypto";
import { ForbiddenError } from "./access";
import { audit } from "./audit";
import { iso, loadOrder, nowMs, PaymentError, who, errMsg, type Deps, type PayActor } from "./payments";
import { validatePayeeUrl, validateServerUrl } from "./payee-url";
import type { WalletInfo } from "./provider";

export const PAYEE_ASSET = { code: "USD", scale: 2 };

export type PayeeRow = {
  id: number; owner: string; canonical_url: string; asset_code: string; asset_scale: number; public_name: string;
  verified_at: string | null; verified_by: number | null; verified_fingerprint: string | null; verified_public_name: string | null;
};

/** The wallets that get paid for an order (farmers + logistics; the cooperative's retained row is not paid). */
export function payeeWallets(db: Deps["db"], orderId: number): PayeeRow[] {
  return db
    .prepare(
      `SELECT w.* FROM allocations a JOIN wallets w ON w.owner = a.recipient
       WHERE a.order_id = ? AND a.kind IN ('farmer','logistics') ORDER BY a.id`,
    )
    .all(orderId) as PayeeRow[];
}

export const isVerified = (w: PayeeRow) => !!w.verified_at && !!w.verified_by && !!w.verified_fingerprint;

/** Fingerprint of everything the provider told us that identifies the wallet. A change means "not the same wallet". */
export function walletFingerprint(i: WalletInfo): string {
  return createHash("sha256").update(JSON.stringify([i.id, i.assetCode, i.assetScale, i.authServer, i.resourceServer, i.publicName ?? ""])).digest("hex");
}

export type PayeeCheck = { owner: string; url: string; ok: boolean; reason?: string; publicName?: string; canonicalUrl?: string };

/** All checks for one wallet. Returns the provider info when everything passes. */
export async function checkPayee(d: Deps, w: PayeeRow): Promise<{ ok: true; info: WalletInfo } | { ok: false; reason: string }> {
  const pre = validatePayeeUrl(w.canonical_url);
  if (!pre.ok) return { ok: false, reason: `Address refused before lookup: ${pre.reason}` };
  if (pre.url !== w.canonical_url) return { ok: false, reason: "Stored address is not in canonical form" };
  let info: WalletInfo;
  try {
    info = await d.provider.getWalletStrict(w.canonical_url);
  } catch (e) {
    return { ok: false, reason: `Provider lookup failed: ${errMsg(e)}` };
  }
  if (info.id !== w.canonical_url) return { ok: false, reason: `Canonical URL mismatch: provider says ${info.id}` };
  if (info.assetCode !== PAYEE_ASSET.code) return { ok: false, reason: `Wrong asset: ${info.assetCode}, expected ${PAYEE_ASSET.code}` };
  if (info.assetScale !== PAYEE_ASSET.scale) return { ok: false, reason: `Wrong scale: ${info.assetScale}, expected ${PAYEE_ASSET.scale}` };
  if (w.asset_code !== PAYEE_ASSET.code || w.asset_scale !== PAYEE_ASSET.scale) return { ok: false, reason: "Stored asset is not USD/2" };
  for (const s of [info.authServer, info.resourceServer]) {
    const c = validateServerUrl(s);
    if (!c.ok) return { ok: false, reason: `Unsafe server in wallet document: ${c.reason}` };
  }
  return { ok: true, info };
}

/** Operator action: resolve and check all payees, store who confirmed and when. */
export async function verifyPayees(d: Deps, actor: PayActor, orderId: number): Promise<PayeeCheck[]> {
  if (actor.role !== "operator") throw new ForbiddenError("Only operators can verify payees");
  loadOrder(d.db, orderId);
  const results: PayeeCheck[] = [];
  for (const w of payeeWallets(d.db, orderId)) {
    const r = await checkPayee(d, w);
    if (r.ok) {
      d.db
        .prepare("UPDATE wallets SET verified_at = ?, verified_by = ?, verified_fingerprint = ?, verified_public_name = ? WHERE id = ?")
        .run(iso(nowMs(d)), actor.id, walletFingerprint(r.info), r.info.publicName ?? null, w.id);
      audit(d.db, { actor: who(actor), action: "PAYEE_VERIFIED", entityType: "order", entityId: orderId, metadata: { wallet: w.owner, url: w.canonical_url, publicName: r.info.publicName ?? null } });
      results.push({ owner: w.owner, url: w.canonical_url, ok: true, publicName: r.info.publicName, canonicalUrl: r.info.id });
    } else {
      invalidate(d, w, orderId, r.reason, actor);
      results.push({ owner: w.owner, url: w.canonical_url, ok: false, reason: r.reason });
    }
  }
  return results;
}

function invalidate(d: Deps, w: PayeeRow, orderId: number, reason: string, actor?: PayActor | string) {
  d.db.prepare("UPDATE wallets SET verified_at = NULL, verified_by = NULL, verified_fingerprint = NULL, verified_public_name = NULL WHERE id = ?").run(w.id);
  audit(d.db, {
    actor: typeof actor === "string" ? actor : actor ? who(actor) : "system", action: "PAYEE_VERIFICATION_FAILED", entityType: "order", entityId: orderId,
    metadata: { wallet: w.owner, url: w.canonical_url, reason },
  });
}

/**
 * Before locking or releasing money: every payee must be verified AND still look identical at the provider.
 * A changed wallet loses its verification on the spot.
 */
export async function assertPayeesVerified(d: Deps, orderId: number, actorLabel = "system"): Promise<PayeeRow[]> {
  const wallets = payeeWallets(d.db, orderId);
  if (wallets.length === 0) throw new PaymentError("No payees found for this order");
  const notVerified = wallets.filter((w) => !isVerified(w));
  if (notVerified.length) throw new PaymentError(`Payees not verified: ${notVerified.map((w) => w.public_name).join(", ")}. Verify payees first.`);
  for (const w of wallets) {
    const r = await checkPayee(d, w);
    if (!r.ok) {
      invalidate(d, w, orderId, `Changed or unreachable after verification: ${r.reason}`, actorLabel);
      throw new PaymentError(`${w.public_name}: wallet could not be re-confirmed (${r.reason}). Verification was removed.`);
    }
    if (walletFingerprint(r.info) !== w.verified_fingerprint) {
      invalidate(d, w, orderId, "Wallet details changed since verification", actorLabel);
      throw new PaymentError(`${w.public_name}: wallet details changed since it was verified. Verification was removed; verify again.`);
    }
  }
  return payeeWallets(d.db, orderId);
}

export type PayeeView = { owner: string; seededName: string; providerName: string | null; url: string; asset: string; verified: boolean; verifiedAt: string | null; verifiedBy: string | null };

/** For the operator screens. The provider's public name is shown for review but is not proof of identity. */
export function getPayeeView(db: Deps["db"], orderId: number): PayeeView[] {
  return payeeWallets(db, orderId).map((w) => {
    const by = w.verified_by ? (db.prepare("SELECT name FROM users WHERE id = ?").get(w.verified_by) as { name: string } | undefined) : undefined;
    return {
      owner: w.owner, seededName: w.public_name, providerName: w.verified_public_name, url: w.canonical_url, asset: `${w.asset_code}/${w.asset_scale}`,
      verified: isVerified(w), verifiedAt: w.verified_at, verifiedBy: by?.name ?? null,
    };
  });
}
