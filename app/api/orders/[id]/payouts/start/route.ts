import { operatorAction } from "../../../../../../lib/http";
import { startPayouts } from "../../../../../../lib/payouts";

// Operator only: create one payout operation per recipient (idempotent) and quote each one.
export const POST = operatorAction<{ params: Promise<{ id: string }> }>("payoutStart", async (d, actor, id) => {
  await startPayouts(d, actor, id);
  return "payouts_started";
});
