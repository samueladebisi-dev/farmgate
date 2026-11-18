import { withRole } from "../../../../../lib/auth";
import { idParam, readForm } from "../../../../../lib/guard";
import { getDeps, noticeRedirect } from "../../../../../lib/http";
import { PaymentError, quoteOrder } from "../../../../../lib/payments";

// Buyer only, own order only (checked inside quoteOrder). Creates the incoming payment + quote.
export const POST = withRole<{ params: Promise<{ id: string }> }>(
  ["buyer"],
  async (actor, req, ctx) => {
    const id = idParam((await ctx.params).id);
    await readForm(req, {}); // no fields accepted
    try {
      await quoteOrder(getDeps(), actor, id);
      return noticeRedirect(req, "/buyer", "quote_ok");
    } catch (e) {
      if (e instanceof PaymentError) return noticeRedirect(req, "/buyer", "error", e);
      throw e;
    }
  },
  { limit: "quote" },
);
