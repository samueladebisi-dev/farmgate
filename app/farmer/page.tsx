import { getFarmerRecord } from "../../lib/access";
import { requirePage } from "../../lib/auth";
import { getDb } from "../../lib/db";
import { formatMoney } from "../../lib/money";
import { receiptFromAllocation } from "../../lib/receipt";
import { CopyText } from "../components/copy-text";
import { money, Table, Td } from "../components/ui";

// Mobile first: one column, big numbers, words only. Only the signed-in farmer's own data, never another recipient's.
export default async function FarmerPage() {
  const actor = await requirePage(["farmer"]);
  // Always the signed-in farmer's own id, never taken from the URL.
  const records = getFarmerRecord(getDb(), actor, actor.linkedFarmerId!);
  return (
    <div className="flex flex-col gap-10">
      <h1 className="text-xl font-semibold">Your payments</h1>
      {records.length === 0 && <p>Nothing for you yet.</p>}
      {records.map((r) => {
        const a = r.allocation;
        const receipt = a ? receiptFromAllocation({ ...a, orderRef: r.orderRef }) : null;
        return (
          <section key={r.orderRef} className="flex flex-col gap-4 border-2 border-black p-4">
            <h2 className="text-base font-semibold">Order {r.orderRef}</h2>
            {receipt && a && (
              <>
                <div>
                  <div className="text-sm">{a.payoutState === "CONFIRMED" ? "You got" : "You will get"}</div>
                  <div className="text-4xl font-bold leading-tight">{receipt.amountText}</div>
                  <div className="text-2xl font-semibold mt-1">{receipt.statusWords}</div>
                </div>
                <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-lg">
                  <dt>Gross</dt><dd className="text-right">{receipt.grossText}</dd>
                  <dt>Fee</dt><dd className="text-right">{receipt.feeText}</dd>
                  <dt>Logistics deduction</dt><dd className="text-right">{receipt.deductionText}</dd>
                  <dt className="font-semibold">Net</dt><dd className="text-right font-semibold">{receipt.netText}</dd>
                  <dt>Reference</dt><dd className="text-right font-mono">{receipt.reference}</dd>
                </dl>
                <div className="flex flex-col gap-2">
                  <h3 className="font-semibold">Text version</h3>
                  <CopyText text={receipt.text} />
                  <p className="text-sm">This is a manual copy. No SMS is sent by this app.</p>
                </div>
              </>
            )}
            <details>
              <summary className="text-sm cursor-pointer">Produce lines</summary>
              <Table head={["Produce", "Kg", "Price per kg", "Total"]}>
                {r.items.map((i, n) => (
                  <tr key={n}>
                    <Td>{i.produce}</Td><Td right>{i.kg}</Td>
                    <Td right>{formatMoney(i.priceMinorPerKg, i.gross.assetCode, i.gross.assetScale)}</Td><Td right>{money(i.gross)}</Td>
                  </tr>
                ))}
              </Table>
            </details>
          </section>
        );
      })}
    </div>
  );
}
