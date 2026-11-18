// Seed logic (used by scripts/seed.ts and by tests). Creates users, wallets, demo order PO-0124.
import type { Db } from "./db";
import { buildDemoOrder } from "./money";
import { insertOrder } from "./orders";
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

  db.transaction(() => {
    const addUser = db.prepare("INSERT INTO users (username, role, name, password_hash, linked_farmer_id) VALUES (?,?,?,?,?)");
    const buyerId = Number(addUser.run("buyer", "buyer", "Demo Buyer", hashPassword(opts.passwords.buyer), null).lastInsertRowid);
    addUser.run("operator", "operator", "Cooperative Operator", hashPassword(opts.passwords.operator), null);
    addUser.run("farmer-a", "farmer", "Farmer A", hashPassword(opts.passwords.farmerA), "farmer-a");
    addUser.run("farmer-b", "farmer", "Farmer B", hashPassword(opts.passwords.farmerB), "farmer-b");
    addUser.run("farmer-c", "farmer", "Farmer C", hashPassword(opts.passwords.farmerC), "farmer-c");

    // verified_at stays NULL: these were looked up in the payment spike, but the app has not re-verified them yet.
    const addWallet = db.prepare("INSERT INTO wallets (owner, canonical_url, asset_code, asset_scale, public_name, verified_at) VALUES (?,?,?,?,?,NULL)");
    for (const w of WALLETS) addWallet.run(w.owner, w.url, w.code, 2, w.name);

    // The demo order goes through the same code as the Create order form (unapproved allocations, AWAITING_PAYMENT).
    insertOrder(db, { buyerUserId: buyerId, items, orderRef: "PO-0124", origin: "SEED", actorLabel: "system", auditAction: "seed.order_created" });
  })();
  return { seeded: true };
}
