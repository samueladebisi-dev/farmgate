import { getOrderItems, listOrders } from "../../lib/access";
import { requirePage } from "../../lib/auth";
import { getDb } from "../../lib/db";
import { getDeps } from "../../lib/http";
import { formatMoney } from "../../lib/money";
import { getFailureMessage, getPaymentView, MIN_QUOTE_MS } from "../../lib/payments";
import { money, Table, Td } from "../components/ui";
import { AuthorizeButton } from "./authorize-button";

// Fixed sentences only. Provider detail text is looked up from our own audit log (see getFailureMessage).
const NOTICES: Record<string, string> = {
  quote_ok: "Quote created.",
  payment_submitted: "Payment submitted. The status below comes from the payment provider.",
  consent_cancelled: "You declined the payment in the wallet. Nothing was paid. You can try again.",
  callback_rejected: "The return from the wallet was rejected and nothing was paid. Please start again.",
  reconciled: "Status checked with the payment provider.",
};

export default async function BuyerPage({ searchParams }: { searchParams: Promise<{ notice?: string; ref?: string }> }) {
  const actor = await requirePage(["buyer"]);
  const sp = await searchParams;
  const db = getDb();
  const deps = getDeps();
  const orders = listOrders(db, actor);
  const notice =
    sp.notice === "error" ? getFailureMessage(db, actor, Number(sp.ref)) ?? "Something went wrong." : sp.notice ? NOTICES[sp.notice] : undefined;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Your orders</h1>
      {notice && (
        <p role="status" className={`border-2 px-3 py-2 text-sm ${sp.notice === "error" || sp.notice === "callback_rejected" ? "border-red-700" : "border-black"}`}>
          {notice}
        </p>
      )}
      {orders.length === 0 && <p>No orders.</p>}
      {orders.map((o) => {
        const items = getOrderItems(db, actor, o.id);
        const pay = getPaymentView(deps, actor, o.id);
        return (
          <section key={o.id} className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">{o.orderRef}</h2>
            <Table head={["Produce", "Kg", "Price per kg", "Line total"]}>
              {items.map((i, n) => (
                <tr key={n}>
                  <Td>{i.produce}</Td>
                  <Td right>{i.kg}</Td>
                  <Td right>{formatMoney(i.priceMinorPerKg, i.gross.assetCode, i.gross.assetScale)}</Td>
                  <Td right>{money(i.gross)}</Td>
                </tr>
              ))}
            </Table>

            <h3 className="font-semibold">Payment</h3>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt>Status</dt>
              <dd className="font-semibold">{pay.statusWords}</dd>
              <dt>Cooperative receives (fixed)</dt>
              <dd>{pay.expectedText}</dd>
              <dt>Your wallet</dt>
              <dd>
                {pay.buyerWalletUrl} ({pay.buyerWalletVerifiedAt ? `verified ${pay.buyerWalletVerifiedAt}` : "not verified yet, verified when you get a quote"})
              </dd>
              {pay.hasQuote && pay.orderStatus === "AWAITING_PAYMENT" && (
                <>
                  <dt>You pay (quoted)</dt>
                  <dd>{pay.quoteDebitText}</dd>
                  <dt>Quote expires</dt>
                  <dd>
                    {pay.quoteExpiresAt} {pay.quoteExpired ? "(expired or about to expire)" : ""}
                  </dd>
                </>
              )}
            </dl>
            {pay.consentRejected && <p className="text-sm">You declined the last approval in the wallet. That is not a failed payment. You can authorize again while the quote is valid.</p>}

            <div className="flex flex-wrap gap-4 items-start">
              {pay.canQuote && (
                <form method="POST" action={`/api/orders/${o.id}/quote`}>
                  <button className="border-2 border-black px-3 py-2 font-medium">{pay.hasQuote ? "Get a new quote" : "Get quote"}</button>
                </form>
              )}
              {pay.canAuthorize && pay.quoteExpiresAt && <AuthorizeButton orderId={o.id} expiresAtMs={Date.parse(pay.quoteExpiresAt)} minMs={MIN_QUOTE_MS} />}
              {pay.canReconcile && (
                <form method="POST" action={`/api/orders/${o.id}/reconcile`}>
                  <button className="border px-3 py-2">Check payment status</button>
                </form>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
