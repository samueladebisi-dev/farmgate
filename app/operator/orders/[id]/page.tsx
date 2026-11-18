import { notFound } from "next/navigation";
import { getAllocations, getOrderItems, listOrders } from "../../../../lib/access";
import { getAuditView } from "../../../../lib/audit-view";
import { requirePage } from "../../../../lib/auth";
import { getDb } from "../../../../lib/db";
import { getDeps } from "../../../../lib/http";
import { formatMoney } from "../../../../lib/money";
import { getPayeeView } from "../../../../lib/payees";
import { getFailureMessage, getPaymentView } from "../../../../lib/payments";
import { getPayoutView } from "../../../../lib/payouts";
import { listReceiptLinks } from "../../../../lib/receipt-links";
import { CopyId } from "../../../components/copy-id";
import { money, Table, Td } from "../../../components/ui";
import { ReceiptLinkCreator } from "./receipt-link-creator";

const NOTICES: Record<string, string> = {
  reconciled: "Status checked with the payment provider.",
  payees_verified: "All four payees were looked up and verified. Review the names and addresses below.",
  payees_failed: "At least one payee failed verification. See the table and the audit list.",
  approved: "Split approved and locked.",
  payouts_started: "Payout operations created and quoted. Review the quotes, then authorize in the wallet.",
  requoted: "Quotes replaced. Review them again before authorizing.",
  retry_started: "New attempt started with a fresh quote.",
  payouts_submitted: "Wallet approval received. The payout results below come from the provider.",
  consent_cancelled: "Wallet approval was declined (an earlier cancelled consent, not a failed transfer). Nothing was paid. You can authorize again.",
  callback_rejected: "The return from the wallet was rejected and nothing was paid. See the audit list.",
  order_created: "Order created. It is waiting for the buyer's payment.",
  demo_created: "Fresh demo order created. Earlier orders, payments, payouts and the audit log were not touched.",
  receipt_revoked: "Receipt link revoked. It stops working immediately.",
};

export default async function OrderPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ notice?: string; ref?: string }> }) {
  const actor = await requirePage(["operator"]);
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const o = listOrders(db, actor).find((x) => x.id === Number(id));
  if (!o) notFound();
  const deps = getDeps();
  const notice = sp.notice === "error" ? getFailureMessage(db, actor, Number(sp.ref)) ?? "Something went wrong." : sp.notice ? NOTICES[sp.notice] : undefined;
  const isBad = sp.notice === "error" || sp.notice === "callback_rejected" || sp.notice === "payees_failed";

  const items = getOrderItems(db, actor, o.id);
  const allocs = getAllocations(db, actor, o.id);
  const { assetCode: code, assetScale: scale } = o.expected;
  const pay = getPaymentView(deps, actor, o.id);
  const payees = getPayeeView(db, o.id);
  const payouts = getPayoutView(deps, actor, o.id);
  const audit = getAuditView(db, actor, o.id);
  const links = listReceiptLinks(db, actor, o.id);
  const total = allocs.reduce((s, a) => s + a.net.minor, 0);
  const post = (action: string, label: string, extra?: React.ReactNode, strong = true) => (
    <form method="POST" action={action} className="inline-flex gap-2 items-center">
      {extra}
      <button className={`${strong ? "border-2 border-black font-medium" : "border"} px-3 py-2`}>{label}</button>
    </form>
  );
  const recipients = allocs.filter((a) => a.kind !== "cooperative");

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm"><a className="underline" href="/operator">All orders</a></p>
      <h1 className="text-xl font-semibold">{o.orderRef}</h1>
      {notice && <p role="status" className={`border-2 px-3 py-2 text-sm ${isBad ? "border-red-700" : "border-black"}`}>{notice}</p>}
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>Buyer</dt><dd>{o.buyerName} ({o.buyerWallet.assetCode} wallet)</dd>
        <dt>Order status</dt><dd className="font-semibold">{o.status} (version {o.version})</dd>
        <dt>Expected to receive</dt><dd>{money(o.expected)}</dd>
        <dt>Confirmed received</dt><dd>{o.confirmedReceivedMinor === null ? "Not confirmed yet" : formatMoney(o.confirmedReceivedMinor, code, scale)}</dd>
        <dt>Allocation total</dt><dd>{formatMoney(total, code, scale)} {total === o.expected.minor ? "(matches expected)" : "(DOES NOT match expected)"}</dd>
      </dl>

      <h3 className="font-semibold">Items</h3>
      <Table head={["Farmer", "Produce", "Kg", "Price per kg", "Gross"]}>
        {items.map((i, n) => (
          <tr key={n}><Td>{i.farmerName}</Td><Td>{i.produce}</Td><Td right>{i.kg}</Td><Td right>{formatMoney(i.priceMinorPerKg, code, scale)}</Td><Td right>{money(i.gross)}</Td></tr>
        ))}
      </Table>

      <h3 className="font-semibold">Allocation and payout status</h3>
      <Table head={["Ref", "Recipient", "Gross", "Fee", "Logistics deduction", "Net", "Payout status"]}>
        {allocs.map((a) => (
          <tr key={a.recipient}>
            <Td>{a.kind === "cooperative" ? "-" : a.reference}</Td>
            <Td>{a.recipientName}</Td><Td right>{money(a.gross)}</Td><Td right>{formatMoney(a.feeMinor, code, scale)}</Td>
            <Td right>{formatMoney(a.deductionMinor, code, scale)}</Td><Td right>{money(a.net)}</Td>
            <Td>{a.kind === "cooperative" ? "Retained" : a.dashboardWords}</Td>
          </tr>
        ))}
        <tr className="font-semibold"><Td>Total</Td><Td /><Td /><Td /><Td /><Td right>{formatMoney(total, code, scale)}</Td><Td /></tr>
      </Table>

      <h3 className="font-semibold">Buyer payment (incoming)</h3>
      {pay.operator?.exception && <p className="border-2 border-red-700 px-3 py-2 text-sm">EXCEPTION {pay.operator.exception}. Details: {pay.operator.exceptionDetail}</p>}
      {pay.operator && pay.operator.unusedEarlierQuotes > 0 && <p className="text-sm">{pay.operator.unusedEarlierQuotes} unused earlier quote(s), expired, nothing received.</p>}
      {pay.operator && pay.operator.resources.length === 0 && pay.operator.unusedEarlierQuotes === 0 && <p className="text-sm">No payment started yet.</p>}
      {pay.operator && pay.operator.resources.length > 0 && (
        <Table head={["#", "Status", "Amounts", "Provider ids"]}>
          {pay.operator.resources.map((r) => (
            <tr key={r.id} className="align-top">
              <Td>{r.id}</Td>
              <Td>{r.words}</Td>
              <td className="border-b px-2 py-1 text-sm">
                <div>Quote debit {r.debit ?? "-"}</div>
                <div>Receive {r.receive ?? "-"}</div>
                <div>Provider received {r.received ?? "-"} (completed: {r.completed === null ? "-" : r.completed ? "yes" : "no"})</div>
                <div>Sent {r.sent ?? "-"}</div>
              </td>
              <td className="border-b px-2 py-1 text-sm">
                <div><CopyId label="incoming" value={r.incomingId} /></div>
                <div><CopyId label="quote" value={r.quoteId} /></div>
                <div><CopyId label="outgoing" value={r.outgoingId} /></div>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {pay.canReconcile && post(`/api/orders/${o.id}/reconcile`, "Reconcile buyer payment with provider")}

      <h3 className="font-semibold">Payees</h3>
      <p className="text-sm">The provider's public name is shown for you to review. It is not proof of identity: check the exact address.</p>
      <Table head={["Wallet", "Exact canonical address", "Provider public name", "Asset", "Verified"]}>
        {payees.map((p) => (
          <tr key={p.owner} className="align-top">
            <Td>{p.seededName}</Td>
            <td className="border-b px-2 py-1 text-sm break-all">{p.url}</td>
            <Td>{p.providerName ?? "-"}</Td>
            <Td>{p.asset}</Td>
            <Td>{p.verified ? `Yes, by ${p.verifiedBy ?? "operator"}` : "No"}</Td>
          </tr>
        ))}
      </Table>
      {(o.status === "RECEIVED" || o.status === "APPROVED") && post(`/api/orders/${o.id}/verify-payees`, o.status === "RECEIVED" ? "Verify payees" : "Re-verify payees", undefined, false)}

      <h3 className="font-semibold">Approval</h3>
      {o.status === "RECEIVED" && <p className="text-sm">Provider has confirmed the buyer payment. <a className="underline font-medium" href={`/operator/review/${o.id}`}>Review and approve the split</a></p>}
      {o.status === "AWAITING_PAYMENT" && <p className="text-sm">Waiting for the buyer payment to be confirmed by the provider.</p>}
      {(o.status === "APPROVED" || o.status === "COMPLETED") && <p className="text-sm">Split approved and locked (approval version {payouts.approvalVersion}).</p>}

      {(o.status === "APPROVED" || o.status === "COMPLETED") && (
        <>
          <h3 className="font-semibold">Payouts</h3>
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            <dt>PROJECTED all-payout debit (current quotes)</dt><dd>{payouts.projectedDebitText}</dd>
            <dt>ACTUAL provider-confirmed debit</dt><dd>{payouts.actualDebitText}</dd>
          </dl>
          {payouts.affordability && <p className="border-2 border-red-700 px-3 py-2 text-sm">{payouts.affordability}</p>}
          {payouts.canStart && post(`/api/orders/${o.id}/payouts/start`, "Start payouts (create operations and quotes)")}
          {payouts.rows.length > 0 && (
            <Table head={["Recipient", "Net", "Status", "Quote and amounts", "Provider ids", "Actions"]}>
              {payouts.rows.map((r) => (
                <tr key={r.id} className="align-top">
                  <Td>{r.name} <span className="text-xs">(attempt {r.attemptNumber})</span></Td>
                  <Td right>{r.netText}</Td>
                  <td className="border-b px-2 py-1 text-sm">
                    <div className="font-semibold">{r.words}</div>
                    {r.consentRejected && <div>Earlier consent cancelled in the wallet. Not a failed transfer.</div>}
                    {r.blocked && <div className="text-red-700">{r.blocked}</div>}
                    {r.failureMessage && r.state === "FAILED" && <div className="text-xs break-words">{r.failureMessage}</div>}
                  </td>
                  <td className="border-b px-2 py-1 text-sm">
                    <div>Quoted debit {r.quoteDebitText ?? "-"}</div>
                    <div>Quote expires {r.quoteExpiresAt ?? "-"}{r.quoteExpired ? " (expired)" : ""}</div>
                    <div>Provider received {r.receivedText ?? "-"}</div>
                    <div>Sent {r.sentText ?? "-"}</div>
                  </td>
                  <td className="border-b px-2 py-1 text-sm">
                    <div><CopyId label="incoming" value={r.incomingId} /></div>
                    <div><CopyId label="quote" value={r.quoteId} /></div>
                    <div><CopyId label="outgoing" value={r.outgoingId} /></div>
                  </td>
                  <td className="border-b px-2 py-1 text-sm">
                    <div className="flex flex-col gap-1 items-start">
                      {r.canAuthorize && post(`/api/orders/${o.id}/payouts/authorize`, "Authorize this payout", <input type="hidden" name="operationId" value={r.id} />, false)}
                      {r.canReconcile && post(`/api/payouts/${r.id}/reconcile`, "Check status", undefined, false)}
                      {r.canRetry && post(`/api/payouts/${r.id}/retry`, "New attempt", undefined, false)}
                    </div>
                  </td>
                </tr>
              ))}
            </Table>
          )}
          <div className="flex flex-wrap gap-3">
            {payouts.canRequote && post(`/api/orders/${o.id}/payouts/requote`, "Re-quote payouts", undefined, false)}
            {payouts.canAuthorizeAll && post(`/api/orders/${o.id}/payouts/authorize`, "Authorize all payouts in wallet")}
          </div>
        </>
      )}

      <h3 className="font-semibold">Recipient receipts</h3>
      <p className="text-sm">
        A receipt link shows ONE recipient's amount and status. No login, no wallet address, no phone number. It expires within 24 hours and can be revoked.
        The link is shown once when you create it (only a hash is stored).
      </p>
      <ReceiptLinkCreator orderId={o.id} recipients={recipients.map((r) => ({ id: r.id, name: r.recipientName, reference: r.reference ?? "" }))} />
      {links.length > 0 && (
        <Table head={["Recipient", "Created", "Expires", "Status", "Views", ""]}>
          {links.map((l) => (
            <tr key={l.id}>
              <Td>{l.recipientName}</Td>
              <Td>{l.createdAt.replace("T", " ").slice(0, 16)}</Td>
              <Td>{l.expiresAt.replace("T", " ").slice(0, 16)}</Td>
              <Td>{l.status}</Td>
              <Td right>{l.viewCount}</Td>
              <td className="border-b px-2 py-1">{l.status === "ACTIVE" && post(`/api/receipt-links/${l.id}/revoke`, "Revoke", undefined, false)}</td>
            </tr>
          ))}
        </Table>
      )}

      <h3 className="font-semibold">Audit</h3>
      <Table head={["Time", "Who", "Event", "Detail"]}>
        {audit.map((e) => (
          <tr key={e.id} className="align-top">
            <Td>{e.at.replace("T", " ").slice(0, 19)}</Td>
            <Td>{e.actor}</Td>
            <td className="border-b px-2 py-1 text-sm">{e.label}</td>
            <td className="border-b px-2 py-1 text-xs break-words max-w-xs">{e.detail}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
