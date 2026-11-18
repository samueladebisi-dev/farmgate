import { NextResponse } from "next/server";
import { operatorAction } from "../../../../../../lib/http";
import { authorizePayouts } from "../../../../../../lib/payouts";

// Operator only: start wallet consent (all payouts in one approval, or one payout when operationId is given).
export const POST = operatorAction<{ params: Promise<{ id: string }> }>(
  "payoutAuthorize",
  async (d, actor, id, fields) => {
    const { redirectUrl } = await authorizePayouts(d, actor, id, fields.operationId ? Number(fields.operationId) : undefined);
    return NextResponse.redirect(redirectUrl, 303);
  },
  { form: { operationId: { re: /^[1-9]\d{0,9}$/, optional: true } } },
);
