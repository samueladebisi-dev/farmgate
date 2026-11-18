import { NextResponse } from "next/server";
import { getActor } from "../../../../lib/auth";
import { getDeps, guardRequest, noticeRedirect, redirectTo } from "../../../../lib/http";
import { handleCallback } from "../../../../lib/payments";

// The wallet sends the buyer's browser back here after consent. Everything is verified inside handleCallback;
// every rejection is written to audit_events. A signed-out visitor is audited too, then sent to log in.
export async function GET(req: Request) {
  const actor = await getActor();
  const blocked = guardRequest(req, actor ? String(actor.id) : "anon", "callback", 20);
  if (blocked) return blocked;
  const url = new URL(req.url);
  const result = await handleCallback(getDeps(), actor, url.searchParams);
  if (!actor) return redirectTo(req, "/login");
  const notice = result.kind === "PROCESSING" ? "payment_submitted" : result.kind === "CANCELLED" ? "consent_cancelled" : "error";
  // Callback failures show only our own safe sentence, never provider details.
  if (result.kind === "REJECTED") return redirectTo(req, `/buyer?notice=callback_rejected`);
  return noticeRedirect(req, "/buyer", notice);
}
