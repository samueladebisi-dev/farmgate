// Seed logic (used by scripts/seed.ts and by tests). Creates users, wallets, demo order PO-0124.
import { audit } from "./audit";
import type { Db } from "./db";
import { buildDemoOrder, buildLedger } from "./money";
import { hashPassword } from "./password";

export type SeedPasswords = { buyer: string; operator: string; farmerA: string; farmerB: string; farmerC: string };

const BASE = "https://ilp.interledger-test.dev";
const WALLETS = [
  { owner: "buyer", url: `${BASE}/da5d080e`, code: "EUR", name: "Demo Buyer" },
  { owner: "cooperative", url: `${BASE}/argus-coop`, code: "USD", name: "Argus Cooperative" },
  { owner: "farmer-a", url: `${BASE}/argus-farmer-a`, code: "USD", name: "Farmer A" },
  { owner: "farmer-b", url: `${BASE}/argus-farmer-b`, code: "USD", name: "Farmer B" },
  { owner: "farmer-c", url: `${BASE}/argus-farmer-c`, code: "USD", name: "Farmer C" },
  { owner: "logistics", url: `${BASE}/argus-logistics`, code: "USD", name: "Logistics" },
];

export function seedDatabase(db: Db, opts: { orderTotalMinor: number; passwords: SeedPasswords }): { seeded: boolean } {
  if (db.prepare("SELECT 1 FROM orders WHERE order_ref = 'PO-0124'").get()) return { seeded: false };
  const items = buildDemoOrder(opts.orderTotalMinor); // throws if the total is not allowed
  const ledger = buildLedger(items);

  db.transaction(() => {
    const addUser = db.prepare("INSERT INTO users (username, role, name, password_hash, linked_farmer_id) VALUES (?,?,?,?,?)");
    const buyerId = Number(addUser.run("buyer", "buyer", "Demo Buyer", hashPassword(opts.passwords.buyer), null).lastInsertRowid);
    addUser.run("operator", "operator", "Cooperative Operator", hashPassword(opts.passwords.operator), null);
    addUser.run("farmer-a", "farmer", "Farmer A", hashPassword(opts.passwords.farmerA), "farmer-a");
    addUser.run("farmer-b", "farmer", "Farmer B", hashPassword(opts.passwords.farmerB), "farmer-b");
    addUser.run("farmer-c", "farmer", "Farmer C", hashPassword(opts.passwords.farmerC), "farmer-c");

    // verified_at stays NULL: these were looked up in the payment spike, but the app has not re-verified them yet.
    const addWallet = db.prepare("INSERT INTO wallets (owner, canonical_url, asset_code, asset_scale, public_name, verified_at) VALUES (?,?,?,?,?,NULL)");
    const walletId: Record<string, number> = {};
    for (const w of WALLETS) walletId[w.owner] = Number(addWallet.run(w.owner, w.url, w.code, 2, w.name).lastInsertRowid);

    const orderId = Number(
      db
        .prepare(
          `INSERT INTO orders (order_ref, buyer_user_id, buyer_wallet_id, cooperative_wallet_id, expected_receive_minor, asset_code, asset_scale)
           VALUES ('PO-0124', ?, ?, ?, ?, 'USD', 2)`,
        )
        .run(buyerId, walletId.buyer, walletId.cooperative, ledger.totalMinor).lastInsertRowid,
    );

    const addItem = db.prepare(
      "INSERT INTO order_items (order_id, farmer_id, produce, kg, price_minor_per_kg, gross_minor, asset_code, asset_scale) VALUES (?,?,?,?,?,?,'USD',2)",
    );
    for (const i of items) addItem.run(orderId, i.farmerId, i.produce, i.kg, i.priceMinorPerKg, i.grossMinor);

    // Allocation rows: one per farmer, one for logistics (the deductions), one for cooperative (retained fees).
    // approval_version 0 / approved_by NULL = not approved yet. No payouts exist until the operator approves.
    const addAlloc = db.prepare(
      `INSERT INTO allocations (order_id, recipient, kind, gross_minor, fee_minor, deduction_minor, net_minor, asset_code, asset_scale)
       VALUES (?,?,?,?,?,?,?,'USD',2)`,
    );
    for (const i of items) addAlloc.run(orderId, i.farmerId, "farmer", i.grossMinor, i.feeMinor, i.deductionMinor, i.grossMinor - i.feeMinor - i.deductionMinor);
    addAlloc.run(orderId, "logistics", "logistics", ledger.logisticsMinor, 0, 0, ledger.logisticsMinor);
    addAlloc.run(orderId, "cooperative", "cooperative", ledger.feesMinor, 0, 0, ledger.feesMinor);

    audit(db, { actor: "system", action: "seed.order_created", entityType: "order", entityId: orderId, metadata: { orderRef: "PO-0124", expectedReceiveMinor: ledger.totalMinor } });
  })();
  return { seeded: true };
}
