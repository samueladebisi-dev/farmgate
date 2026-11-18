import { NextResponse } from "next/server";
import { withRole } from "../../../../../lib/auth";
import { idParam, readForm } from "../../../../../lib/guard";
import { getDeps, noticeRedirect, redirectTo } from "../../../../../lib/http";
import { PaymentError, reconcileForActor } from "../../../../../lib/payments";

// Operator, or the buyer for their own order. Reads the payments back from the provider.
export const POST = withRole<{ params: Promise<{ id: string }> }>(
  ["operator", "buyer"],
  async (actor, req, ctx) => {
    const id = idParam((await ctx.params).id);
    await readForm(req, {});
    const wantsJson = (req.headers.get("accept") ?? "").includes("application/json");
    const home = actor.role === "operator" ? `/operator/orders/${id}` : "/buyer";
    try {
      const summary = await reconcileForActor(getDeps(), actor, id);
      return wantsJson ? NextResponse.json({ summary }) : redirectTo(req, `${home}?notice=reconciled`);
    } catch (e) {
      if (e instanceof PaymentError) return wantsJson ? NextResponse.json({ error: e.message }, { status: e.status }) : noticeRedirect(req, home, "error", e);
      throw e; // ForbiddenError / NotFoundError are mapped by withRole
    }
  },
  { limit: "reconcile" },
);
