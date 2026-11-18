import { requirePage } from "../../../../lib/auth";
import { getDb } from "../../../../lib/db";
import { listBuyers, listFarmerChoices } from "../../../../lib/orders";
import { NewOrderForm } from "./form";

export default async function NewOrderPage() {
  await requirePage(["operator"]);
  const db = getDb();
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm"><a className="underline" href="/operator">All orders</a></p>
      <h1 className="text-xl font-semibold">Create order</h1>
      <NewOrderForm buyers={listBuyers(db)} farmers={listFarmerChoices(db)} />
    </div>
  );
}
