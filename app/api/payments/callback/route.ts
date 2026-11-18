import { getActor } from "../../../../lib/auth";
import { audit } from "../../../../lib/audit";
import { checkCallbackQuery } from "../../../../lib/callback-params";
import { rateLimited } from "../../../../lib/guard";
import { getDeps, redirectTo } from "../../../../lib/http";
import { handleCallback, peekGrantPurpose, type CallbackResult } from "../../../../lib/payments";
import { handlePayoutCallback, PAYOUT_PURPOSE } from "../../../../lib/payouts";

// The wallet sends the browser back here after consent (buyer payment OR cooperative payouts).
// This is a GET that comes from another site, so it cannot use the same-site check. It is protected by the
// session binding, the one-time consent reference, the nonce/hash check and replay prevention inside the handlers.
// Everything is verified there; every rejection is written to audit_events.
export async function GET(req: Request) {
  const actor = await getActor();
  const limited = rateLimited("callback", actor ? String(actor.id) : "anon");
  if (limited) return limited;
  const d = getDeps();
  const q = new URL(req.url).searchParams;

  const shape = checkCallbackQuery(q);
  if (!shape.ok) {
    audit(d.db, { actor: actor ? `${actor.role}:${actor.id}` : "anonymous", action: "GRANT_REJECTED", entityType: "callback", entityId: "n/a", metadata: { reason: shape.reason, message: "Callback rejected" } });
    return redirectTo(req, actor ? (actor.role === "operator" ? "/operator?notice=callback_rejected" : "/buyer?notice=callback_rejected") : "/login");
  }
  if (shape.unknown.length) {
    audit(d.db, { actor: actor ? `${actor.role}:${actor.id}` : "anonymous", action: "CALLBACK_EXTRA_PARAMS", entityType: "callback", entityId: "n/a", metadata: { names: shape.unknown } });
  }

  const payout = peekGrantPurpose(d.db, actor, q) === PAYOUT_PURPOSE;
  const result: CallbackResult = payout ? await handlePayoutCallback(d, actor, q) : await handleCallback(d, actor, q);
  if (!actor) return redirectTo(req, "/login");
  const base = payout ? (result.orderId ? `/operator/orders/${result.orderId}` : "/operator") : "/buyer";
  if (result.kind === "REJECTED") return redirectTo(req, `${base}?notice=callback_rejected`);
  const notice = result.kind === "PROCESSING" ? (payout ? "payouts_submitted" : "payment_submitted") : "consent_cancelled";
  const url = new URL(base, req.url);
  url.searchParams.set("notice", notice);
  if (payout && result.auditId) url.searchParams.set("ref", String(result.auditId));
  return Response.redirect(url, 303);
}
