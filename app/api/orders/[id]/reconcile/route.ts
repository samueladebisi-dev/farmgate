import { NextResponse } from "next/server";
import { withRole } from "../../../../../lib/auth";
import { guardRequest, getDeps, noticeRedirect, redirectTo } from "../../../../../lib/http";
import { PaymentError, reconcileForActor } from "../../../../../lib/payments";

// Operator, or the buyer for their own order. Reads the payments back from the provider.
export const POST = withRole<{ params: Promise<{ id: string }> }>(["operator", "buyer"], async (actor, req, ctx) => {
  const blocked = guardRequest(req, String(actor.id), "reconcile");
  if (blocked) return blocked;
  const { id } = await ctx.params;
  const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
  const home = actor.role === "operator" ? "/operator" : "/buyer";
  try {
    const summary = await reconcileForActor(getDeps(), actor, Number(id));
    return wantsJson ? NextResponse.json({ summary }) : redirectTo(req, `${home}?notice=reconciled`);
  } catch (e) {
    if (e instanceof PaymentError) return wantsJson ? NextResponse.json({ error: e.message }, { status: e.status }) : noticeRedirect(req, home, "error", e);
    throw e; // ForbiddenError / NotFoundError are mapped by withRole
  }
});
