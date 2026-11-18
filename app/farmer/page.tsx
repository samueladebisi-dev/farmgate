import { getFarmerRecord } from "../../lib/access";
import { requirePage } from "../../lib/auth";
import { getDb } from "../../lib/db";
import { formatMoney } from "../../lib/money";
import { money, Table, Td } from "../components/ui";

export default async function FarmerPage() {
  const actor = await requirePage(["farmer"]);
  // Always the signed-in farmer's own id, never taken from the URL.
  const records = getFarmerRecord(getDb(), actor, actor.linkedFarmerId!);
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Your payments</h1>
      {records.length === 0 && <p>Nothing for you yet.</p>}
      {records.map((r) => {
        const a = r.allocation;
        return (
          <section key={r.orderRef} className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">Order {r.orderRef}</h2>
            {a && (
              <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-base">
                <dt>You will receive</dt>
                <dd className="font-semibold">{money(a.net)}</dd>
                <dt>Status</dt>
                <dd className="font-semibold">{a.farmerWords}</dd>
              </dl>
            )}
            <Table head={["Produce", "Kg", "Price per kg", "Total"]}>
              {r.items.map((i, n) => (
                <tr key={n}>
                  <Td>{i.produce}</Td>
                  <Td right>{i.kg}</Td>
                  <Td right>{formatMoney(i.priceMinorPerKg, i.gross.assetCode, i.gross.assetScale)}</Td>
                  <Td right>{money(i.gross)}</Td>
                </tr>
              ))}
            </Table>
            {a && (
              <p className="text-sm">
                Fee {formatMoney(a.feeMinor, a.gross.assetCode, a.gross.assetScale)} and logistics{" "}
                {formatMoney(a.deductionMinor, a.gross.assetCode, a.gross.assetScale)} are taken from {money(a.gross)}.
              </p>
            )}
          </section>
        );
      })}
    </div>
  );
}
