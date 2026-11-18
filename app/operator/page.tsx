import { getAllocations, getOrderItems, listOrders } from "../../lib/access";
import { requirePage } from "../../lib/auth";
import { getDb } from "../../lib/db";
import { formatMoney } from "../../lib/money";
import { money, Table, Td } from "../components/ui";

export default async function OperatorPage() {
  const actor = await requirePage(["operator"]);
  const db = getDb();
  const orders = listOrders(db, actor);
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Operator dashboard</h1>
      {orders.length === 0 && <p>No orders.</p>}
      {orders.map((o) => {
        const items = getOrderItems(db, actor, o.id);
        const allocs = getAllocations(db, actor, o.id);
        const { assetCode: code, assetScale: scale } = o.expected;
        const total = allocs.reduce((s, a) => s + a.net.minor, 0);
        return (
          <section key={o.id} className="flex flex-col gap-4">
            <h2 className="text-lg font-semibold">{o.orderRef}</h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt>Buyer</dt>
              <dd>
                {o.buyerName} ({o.buyerWallet.assetCode} wallet)
              </dd>
              <dt>Order status</dt>
              <dd>
                {o.status} (version {o.version})
              </dd>
              <dt>Expected to receive</dt>
              <dd>{money(o.expected)}</dd>
              <dt>Confirmed received</dt>
              <dd>{o.confirmedReceivedMinor === null ? "Not confirmed yet" : formatMoney(o.confirmedReceivedMinor, code, scale)}</dd>
              <dt>Allocation total</dt>
              <dd>
                {formatMoney(total, code, scale)} {total === o.expected.minor ? "(matches expected)" : "(DOES NOT match expected)"}
              </dd>
            </dl>
            <h3 className="font-semibold">Items</h3>
            <Table head={["Farmer", "Produce", "Kg", "Price per kg", "Gross"]}>
              {items.map((i, n) => (
                <tr key={n}>
                  <Td>{i.farmerName}</Td>
                  <Td>{i.produce}</Td>
                  <Td right>{i.kg}</Td>
                  <Td right>{formatMoney(i.priceMinorPerKg, code, scale)}</Td>
                  <Td right>{money(i.gross)}</Td>
                </tr>
              ))}
            </Table>
            <h3 className="font-semibold">Allocation</h3>
            <Table head={["Recipient", "Gross", "Fee", "Logistics deduction", "Net", "Payout status"]}>
              {allocs.map((a) => (
                <tr key={a.recipient}>
                  <Td>{a.recipientName}</Td>
                  <Td right>{money(a.gross)}</Td>
                  <Td right>{formatMoney(a.feeMinor, code, scale)}</Td>
                  <Td right>{formatMoney(a.deductionMinor, code, scale)}</Td>
                  <Td right>{money(a.net)}</Td>
                  <Td>{a.kind === "cooperative" ? "Retained" : a.dashboardWords}</Td>
                </tr>
              ))}
              <tr className="font-semibold">
                <Td>Total</Td>
                <Td />
                <Td />
                <Td />
                <Td right>{formatMoney(total, code, scale)}</Td>
                <Td />
              </tr>
            </Table>
          </section>
        );
      })}
    </div>
  );
}
