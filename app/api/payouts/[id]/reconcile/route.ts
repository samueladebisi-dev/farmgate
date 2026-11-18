import { operatorAction } from "../../../../../lib/http";
import { reconcilePayout } from "../../../../../lib/payouts";

// Operator only: re-read one payout from the provider and store the real state.
export const POST = operatorAction<{ params: Promise<{ id: string }> }>(
  "payoutReconcile",
  async (d, actor, id) => {
    await reconcilePayout(d, actor, id);
    return "reconciled";
  },
  { orderOf: (db, id) => (db.prepare("SELECT order_id FROM payout_operations WHERE id = ?").get(id) as { order_id: number } | undefined)?.order_id ?? null },
);
