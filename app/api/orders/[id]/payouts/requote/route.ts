import { operatorAction } from "../../../../../../lib/http";
import { requotePayouts } from "../../../../../../lib/payouts";

// Operator only: replace expired or changed quotes. Nothing is released.
export const POST = operatorAction<{ params: Promise<{ id: string }> }>("payoutRequote", async (d, actor, id) => {
  await requotePayouts(d, actor, id);
  return "requoted";
});
