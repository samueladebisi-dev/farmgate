// Pure reconciliation rules for the INBOUND payment (buyer -> cooperative). No database, no network.
// Input is what the PROVIDER reports; output says what the app may conclude.

export type IncomingFacts = {
  id: string;
  receivedMinor: number;
  assetMatches: boolean; // provider receivedAmount uses the order's asset code + scale
  completed: boolean;
  expired: boolean;
};

export type ExceptionCode = "UNDERPAYMENT" | "OVERPAYMENT" | "DUPLICATE_PAYMENT" | "ASSET_MISMATCH";

export type Decision = {
  /** Provider incoming payment that proves the order was paid exactly. null = do not confirm. */
  confirmIncomingId: string | null;
  exceptions: { code: ExceptionCode; incomingId: string; detail: string }[];
  /** Received > 0 but not complete yet, or nothing yet: keep waiting. */
  waiting: boolean;
};

/**
 * Rules:
 *  - Confirm ONLY when an incoming payment is completed and received EXACTLY the expected amount.
 *  - Under (finished or expired but short): blocked, exception UNDERPAYMENT.
 *  - Over: exception OVERPAYMENT. Not confirmed, so the extra is never distributed.
 *  - Any other incoming payment that also received money for the same order: recorded as
 *    DUPLICATE_PAYMENT. It never triggers the order a second time.
 *  - If the order was already confirmed by `alreadyConfirmedId`, nothing is confirmed again.
 */
export function evaluateReceipts(expectedMinor: number, incomings: IncomingFacts[], alreadyConfirmedId: string | null): Decision {
  const exceptions: Decision["exceptions"] = [];
  let confirm: string | null = null;

  const mismatched = incomings.filter((i) => i.receivedMinor > 0 && !i.assetMatches);
  for (const i of mismatched) exceptions.push({ code: "ASSET_MISMATCH", incomingId: i.id, detail: "Provider reported a different asset than the order" });
  const usable = incomings.filter((i) => i.assetMatches);

  if (alreadyConfirmedId === null) {
    confirm = usable.find((i) => i.completed && i.receivedMinor === expectedMinor)?.id ?? null;
  }
  const winner = alreadyConfirmedId ?? confirm;

  for (const i of usable) {
    if (i.id === winner || i.receivedMinor <= 0) continue;
    if (winner !== null) {
      exceptions.push({ code: "DUPLICATE_PAYMENT", incomingId: i.id, detail: `Extra incoming payment received ${i.receivedMinor} minor units for an order already paid` });
    } else if (i.receivedMinor > expectedMinor) {
      exceptions.push({ code: "OVERPAYMENT", incomingId: i.id, detail: `Received ${i.receivedMinor}, expected ${expectedMinor}, extra ${i.receivedMinor - expectedMinor}` });
    } else if (i.receivedMinor < expectedMinor && (i.completed || i.expired)) {
      exceptions.push({ code: "UNDERPAYMENT", incomingId: i.id, detail: `Received ${i.receivedMinor}, expected ${expectedMinor}, short by ${expectedMinor - i.receivedMinor}` });
    }
  }

  const waiting = winner === null && exceptions.length === 0;
  return { confirmIncomingId: confirm, exceptions, waiting };
}
