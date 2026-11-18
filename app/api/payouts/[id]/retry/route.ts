import { operatorAction } from "../../../../../lib/http";
import { retryPayout } from "../../../../../lib/payouts";

// Operator only: new attempt, allowed only after a provider-confirmed FAILED.
export const POST = operatorAction<{ params: Promise<{ id: string }> }>(
  "payoutRetry",
  async (d, actor, id) => {
    await retryPayout(d, actor, id);
    return "retry_started";
  },
  { orderOf: (db, id) => (db.prepare("SELECT order_id FROM payout_operations WHERE id = ?").get(id) as { order_id: number } | undefined)?.order_id ?? null },
);
