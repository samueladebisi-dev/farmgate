import { notFound } from "next/navigation";
import { requirePage } from "../../../../lib/auth";
import { getReview } from "../../../../lib/approval";
import { getDeps } from "../../../../lib/http";
import { Table, Td } from "../../../components/ui";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await requirePage(["operator"]);
  const { id } = await params;
  const orderId = Number(id);
  if (!Number.isInteger(orderId)) notFound();
  const r = getReview(getDeps(), actor, orderId);

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm"><a className="underline" href="/operator">Back to dashboard</a></p>
      <h1 className="text-xl font-semibold">Review split for {r.orderRef}</h1>
      <p className="text-sm">
        Check each beneficiary's exact wallet address. The public name comes from the provider and is not proof of identity.
        Approving locks these amounts and addresses. If anything changes afterwards, the approval is removed.
      </p>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>Order status</dt><dd>{r.status}</dd>
        <dt>Provider-confirmed received</dt><dd>{r.receivedText}</dd>
      </dl>
      <Table head={["Beneficiary", "Exact wallet address", "Provider public name", "Verified", "Net amount", "Projected debit"]}>
        {r.beneficiaries.map((b) => (
          <tr key={b.recipient} className="align-top">
            <Td>{b.label}</Td>
            <td className="border-b px-2 py-1 text-sm break-all">{b.url}</td>
            <Td>{b.publicName ?? "-"}</Td>
            <Td>{b.verified ? "Yes" : "NO"}</Td>
            <Td right>{b.netText}</Td>
            <Td right>{b.projectedDebitText}</Td>
          </tr>
        ))}
      </Table>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt>Total paid out</dt><dd className="font-semibold">{r.payoutsTotalText}</dd>
        <dt>Retained by the cooperative (not paid out)</dt><dd className="font-semibold">{r.retainedText}</dd>
        <dt>Total allocated</dt><dd className="font-semibold">{r.totalText} {r.allocationMatchesReceived ? "(equals confirmed received)" : "(DOES NOT equal confirmed received)"}</dd>
      </dl>
      <p className="text-sm">Projected debits assume the same currency on both sides, so they equal the net amounts. The real quoted debits replace them when payouts are started.</p>
      {r.exception && <p className="border-2 border-red-700 px-3 py-2 text-sm">Order exception on record: {r.exception}. Extra money is never distributed.</p>}
      {r.blockers.length > 0 && (
        <ul className="border-2 border-red-700 px-3 py-2 text-sm list-disc pl-6">
          {r.blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      )}
      <form method="POST" action={`/api/orders/${r.orderId}/approve`}>
        <input type="hidden" name="fingerprint" value={r.fingerprint} />
        <button disabled={!r.canApprove} className="border-2 border-black px-3 py-2 font-medium disabled:opacity-40">Approve and lock this split</button>
      </form>
    </div>
  );
}
