import { listOrders } from "../../lib/access";
import { requirePage } from "../../lib/auth";
import { getDb } from "../../lib/db";
import { formatMoney } from "../../lib/money";
import { getFailureMessage } from "../../lib/payments";
import { money, Table, Td } from "../components/ui";

export default async function OperatorPage({ searchParams }: { searchParams: Promise<{ notice?: string; ref?: string }> }) {
  const actor = await requirePage(["operator"]);
  const sp = await searchParams;
  const db = getDb();
  const orders = listOrders(db, actor);
  const origins = new Map((db.prepare("SELECT id, origin FROM orders").all() as { id: number; origin: string }[]).map((r) => [r.id, r.origin]));
  const notice = sp.notice === "demo_error" || sp.notice === "error" ? getFailureMessage(db, actor, Number(sp.ref)) ?? "Something went wrong." : undefined;

  return (
    <div className="flex flex-col gap-8">
      <h1 className="text-xl font-semibold">Operator dashboard</h1>
      {notice && <p role="status" className="border-2 border-red-700 px-3 py-2 text-sm">{notice}</p>}

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <h2 className="text-lg font-semibold">Orders</h2>
          <a href="/operator/orders/new" className="border-2 border-black px-3 py-2 font-medium">Create order</a>
        </div>
        {orders.length === 0 && <p>No orders yet.</p>}
        {orders.length > 0 && (
          <Table head={["Order", "Buyer", "Status", "Expected receive", "Confirmed received", "Source", ""]}>
            {orders.map((o) => (
              <tr key={o.id}>
                <Td>{o.orderRef}</Td>
                <Td>{o.buyerName}</Td>
                <Td>{o.status}</Td>
                <Td right>{money(o.expected)}</Td>
                <Td right>{o.confirmedReceivedMinor === null ? "-" : formatMoney(o.confirmedReceivedMinor, o.expected.assetCode, o.expected.assetScale)}</Td>
                <Td>{origins.get(o.id) === "DEMO_RESET" ? "Demo" : origins.get(o.id) === "SEED" ? "Seed" : "Created"}</Td>
                <td className="border-b px-2 py-1"><a className="underline" href={`/operator/orders/${o.id}`}>Open</a></td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Demo: fresh order</h2>
        <p className="text-sm">
          Creates a NEW synthetic order (the worked example scaled to the total you choose) so you can run the demo again.
          It never deletes or changes earlier orders, provider payments, payout history, attempts or the audit log.
          It does not add money to any wallet: check the play-money balances separately in the wallet.
        </p>
        <form method="POST" action="/api/demo/reset" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            Order total (USD, a multiple of 10.00)
            <input name="total" defaultValue="100.00" inputMode="decimal" className="border px-3 py-2 text-base w-40" />
          </label>
          <button className="border-2 border-black px-3 py-2 font-medium">Create fresh demo order</button>
        </form>
      </section>
    </div>
  );
}
