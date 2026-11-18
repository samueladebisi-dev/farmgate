import { NextResponse } from "next/server";
import { withRole } from "../../../../../lib/auth";
import { guardRequest, getDeps, noticeRedirect } from "../../../../../lib/http";
import { PaymentError, startAuthorization } from "../../../../../lib/payments";

// Buyer only. Starts the outgoing-payment grant and sends the browser to the wallet's consent page.
export const POST = withRole<{ params: Promise<{ id: string }> }>(["buyer"], async (actor, req, ctx) => {
  const blocked = guardRequest(req, String(actor.id), "start");
  if (blocked) return blocked;
  const { id } = await ctx.params;
  try {
    const { redirectUrl } = await startAuthorization(getDeps(), actor, Number(id));
    return NextResponse.redirect(redirectUrl, 303);
  } catch (e) {
    if (e instanceof PaymentError) return noticeRedirect(req, "/buyer", "error", e);
    throw e;
  }
});
