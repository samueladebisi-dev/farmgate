import { operatorAction } from "../../../../../lib/http";
import { revokeReceiptLink } from "../../../../../lib/receipt-links";

// Operator only: stops a receipt link working immediately.
export const POST = operatorAction<{ params: Promise<{ id: string }> }>(
  "receiptRevoke",
  async (d, actor, id) => {
    revokeReceiptLink(d.db, actor, id, d.now ? d.now() : Date.now());
    return "receipt_revoked";
  },
  { orderOf: (db, id) => (db.prepare("SELECT order_id FROM receipt_links WHERE id = ?").get(id) as { order_id: number } | undefined)?.order_id ?? null },
);
