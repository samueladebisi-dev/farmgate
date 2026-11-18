// npm run db:seed - create demo users, wallets and order PO-0124 (safe to re-run: skips if it exists).
import "dotenv/config";
import { applyMigrations, dbPath, openDb } from "../lib/db.ts";
import { parseMajorToMinor } from "../lib/money.ts";
import { seedDatabase } from "../lib/seed.ts";

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name} in .env (see .env.example)`);
    process.exit(1);
  }
  return v;
}

const db = openDb(dbPath());
applyMigrations(db);
const orderTotalMinor = parseMajorToMinor(process.env.ORDER_TOTAL_MAJOR?.trim() || "100.00", 2);
const result = seedDatabase(db, {
  orderTotalMinor,
  passwords: {
    buyer: need("DEMO_BUYER_PASSWORD"),
    operator: need("DEMO_OPERATOR_PASSWORD"),
    farmerA: need("DEMO_FARMER_A_PASSWORD"),
    farmerB: need("DEMO_FARMER_B_PASSWORD"),
    farmerC: need("DEMO_FARMER_C_PASSWORD"),
  },
});
console.log(
  result.seeded
    ? `Seeded demo data. Order PO-0124 total: ${process.env.ORDER_TOTAL_MAJOR || "100.00"} USD. Users: buyer, operator, farmer-a, farmer-b, farmer-c.`
    : "PO-0124 already exists, nothing changed. To change the order total, run: npm run db:reset",
);
