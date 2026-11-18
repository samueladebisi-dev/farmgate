import { NextResponse } from "next/server";
import { withRole } from "../../../../../lib/auth";
import { guardRequest, getDeps, noticeRedirect } from "../../../../../lib/http";
import { PaymentError, quoteOrder } from "../../../../../lib/payments";

// Buyer only, own order only (checked inside quoteOrder). Creates the incoming payment + quote.
export const POST = withRole<{ params: Promise<{ id: string }> }>(["buyer"], async (actor, req, ctx) => {
  const blocked = guardRequest(req, String(actor.id), "start");
  if (blocked) return blocked;
  const { id } = await ctx.params;
  try {
    await quoteOrder(getDeps(), actor, Number(id));
    return noticeRedirect(req, "/buyer", "quote_ok");
  } catch (e) {
    if (e instanceof PaymentError) return noticeRedirect(req, "/buyer", "error", e);
    throw e;
  }
});
