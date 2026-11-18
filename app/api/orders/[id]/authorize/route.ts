import { NextResponse } from "next/server";
import { withRole } from "../../../../../lib/auth";
import { idParam, readForm } from "../../../../../lib/guard";
import { getDeps, noticeRedirect } from "../../../../../lib/http";
import { PaymentError, startAuthorization } from "../../../../../lib/payments";

// Buyer only. Starts the outgoing-payment grant and sends the browser to the wallet's consent page.
export const POST = withRole<{ params: Promise<{ id: string }> }>(
  ["buyer"],
  async (actor, req, ctx) => {
    const id = idParam((await ctx.params).id);
    await readForm(req, {});
    try {
      const { redirectUrl } = await startAuthorization(getDeps(), actor, id);
      return NextResponse.redirect(redirectUrl, 303);
    } catch (e) {
      if (e instanceof PaymentError) return noticeRedirect(req, "/buyer", "error", e);
      throw e;
    }
  },
  { limit: "authorize" },
);
