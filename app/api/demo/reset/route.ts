import { withRole } from "../../../../lib/auth";
import { audit } from "../../../../lib/audit";
import { getDb } from "../../../../lib/db";
import { readForm } from "../../../../lib/guard";
import { noticeRedirect, redirectTo } from "../../../../lib/http";
import { createDemoOrder } from "../../../../lib/orders";
import { PaymentError } from "../../../../lib/payments";

// Operator only. "Reset" for demos = create a FRESH synthetic order. It never deletes or rewrites provider payments,
// payout history, attempts or audit events, and it cannot top up a wallet.
export const POST = withRole<unknown>(
  ["operator"],
  async (actor, req) => {
    const { total } = await readForm(req, { total: { re: /^\d{1,7}(\.\d{1,2})?$/ } });
    try {
      const o = createDemoOrder(getDb(), actor, total!);
      return redirectTo(req, `/operator/orders/${o.orderId}?notice=demo_created`);
    } catch (e) {
      if (e instanceof PaymentError) {
        const id = audit(getDb(), { actor: `operator:${actor.id}`, action: "DEMO_ORDER_FAILED", entityType: "demo", entityId: "n/a", metadata: { message: e.message } });
        return noticeRedirect(req, "/operator", "demo_error", new PaymentError(e.message, id));
      }
      throw e;
    }
  },
  { limit: "demoReset" },
);
