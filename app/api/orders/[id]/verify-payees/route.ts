import { operatorAction } from "../../../../../lib/http";
import { verifyPayees } from "../../../../../lib/payees";

// Operator only: look up the four payee wallets (strict allow-list first) and record who confirmed them.
export const POST = operatorAction<{ params: Promise<{ id: string }> }>(
  "verifyPayees",
  async (d, actor, id) => {
    const results = await verifyPayees(d, actor, id);
    return results.every((r) => r.ok) ? "payees_verified" : "payees_failed";
  },
);
