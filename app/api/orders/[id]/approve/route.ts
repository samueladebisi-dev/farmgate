import { approveOrder } from "../../../../../lib/approval";
import { operatorAction } from "../../../../../lib/http";

// Operator only: lock the split. The form carries the fingerprint of the review the operator actually saw.
export const POST = operatorAction<{ params: Promise<{ id: string }> }>(
  "approve",
  async (d, actor, id, fields) => {
    await approveOrder(d, actor, id, fields.fingerprint!);
    return "approved";
  },
  { form: { fingerprint: { re: /^[0-9a-f]{64}$/ } } },
);
