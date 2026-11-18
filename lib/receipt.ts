// Recipient receipts: what ONE recipient sees (amount, status in plain words, their own numbers, a short reference).
// Never includes other recipients, wallet addresses or phone numbers.
import { loadAllocation, type AllocationRow } from "./access";
import type { Db } from "./db";
import { formatMoney } from "./money";
import type { PayoutState } from "./payout-state";

export type Receipt = {
  allocationId: number;
  orderRef: string;
  recipientName: string;
  amountText: string; // "3.70 USD"
  grossText: string;
  feeText: string;
  deductionText: string;
  netText: string;
  statusWords: string; // from the central dictionary (farmer words)
  state: PayoutState | null;
  reference: string; // PAY-041
  text: string; // plain text, under 160 characters
};

/** Plain-text receipt for manual copy. No emoji, always under 160 characters (checked in tests for every state). */
export function receiptText(p: { orderRef: string; amountText: string; paid: boolean; statusWords: string; reference: string }): string {
  return [
    "TEST PAYMENT",
    `Order: ${p.orderRef}`,
    `${p.paid ? "You got" : "You will get"}: ${p.amountText}`,
    `Status: ${p.statusWords}`,
    `Ref: ${p.reference}`,
    "Help: Ask your operator",
  ].join("\n");
}

export function receiptFromAllocation(a: AllocationRow & { orderRef: string }): Receipt {
  const m = (n: number) => formatMoney(n, a.gross.assetCode, a.gross.assetScale);
  const words = a.farmerWords; // central dictionary
  const amountText = formatMoney(a.net.minor, a.net.assetCode, a.net.assetScale);
  return {
    allocationId: a.id, orderRef: a.orderRef, recipientName: a.recipientName, amountText,
    grossText: formatMoney(a.gross.minor, a.gross.assetCode, a.gross.assetScale), feeText: m(a.feeMinor), deductionText: m(a.deductionMinor), netText: amountText,
    statusWords: words, state: a.payoutState, reference: a.reference ?? "PAY-000",
    text: receiptText({ orderRef: a.orderRef, amountText, paid: a.payoutState === "CONFIRMED", statusWords: words, reference: a.reference ?? "PAY-000" }),
  };
}

/** Receipt for one allocation id. No permission check here: the caller decided who may see it. */
export function loadReceipt(db: Db, allocationId: number): Receipt | null {
  const a = loadAllocation(db, allocationId);
  if (!a || a.kind === "cooperative") return null; // the cooperative's retained amount has no recipient receipt
  return receiptFromAllocation(a);
}
