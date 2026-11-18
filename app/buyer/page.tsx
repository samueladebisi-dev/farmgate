import { getOrderItems, listOrders } from "../../lib/access";
import { requirePage } from "../../lib/auth";
import { getDb } from "../../lib/db";
import { formatMoney } from "../../lib/money";
import { money, Table, Td } from "../components/ui";

export default async function BuyerPage() {
  const actor = await requirePage(["buyer"]);
  const db = getDb();
  const orders = listOrders(db, actor);
  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Your orders</h1>
      {orders.length === 0 && <p>No orders.</p>}
      {orders.map((o) => {
        const items = getOrderItems(db, actor, o.id);
        return (
          <section key={o.id} className="flex flex-col gap-3">
            <h2 className="text-lg font-semibold">{o.orderRef}</h2>
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              <dt>Status</dt>
              <dd>{o.status}</dd>
              <dt>Order total</dt>
              <dd>{money(o.expected)}</dd>
              <dt>You pay from</dt>
              <dd>
                {o.buyerWallet.url} ({o.buyerWallet.assetCode})
              </dd>
              <dt>Cooperative receives in</dt>
              <dd>{o.coopWallet.assetCode}. The amount debited from you is only known once a quote is made.</dd>
            </dl>
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
          </section>
        );
      })}
    </div>
  );
}
