// Creating orders: the Create order form, the seed, and the demo "fresh order" button all go through insertOrder.
// Nothing here ever updates or deletes existing orders, payments, payouts or audit rows.
import { ForbiddenError } from "./access";
import { audit } from "./audit";
import type { Db } from "./db";
import { buildDemoOrder, buildLedger, formatMinor, parseMajorToMinor, planOrder, PlanError, type DemoItem, type OrderPlan, type PlanFarmerTerms, type PlanLine } from "./money";
import { PaymentError, type PayActor } from "./payments";
import { BadRequestError, isPlainObject, onlyKeys } from "./validate";

const who = (a: PayActor) => `${a.role}:${a.id}`;

/** PO-0125 style references: one more than the highest number used so far (first ever is PO-0124). */
export function nextOrderRef(db: Db): string {
  const row = db.prepare("SELECT MAX(CAST(SUBSTR(order_ref, 4) AS INTEGER)) AS n FROM orders WHERE order_ref GLOB 'PO-[0-9]*'").get() as { n: number | null };
  return `PO-${String((row.n ?? 123) + 1).padStart(4, "0")}`;
}

export type InsertedOrder = { orderId: number; orderRef: string; expectedReceiveMinor: number };

/**
 * Inserts one order with its items and UNAPPROVED allocations (approval_version 0, no approver).
 * Starts at AWAITING_PAYMENT. Zero-value logistics / cooperative rows are skipped (they could not be paid or shown).
 */
export function insertOrder(
  db: Db,
  p: { buyerUserId: number; items: DemoItem[]; orderRef?: string; origin: "SEED" | "OPERATOR" | "DEMO_RESET"; actorLabel: string; auditAction: string },
): InsertedOrder {
  const ledger = buildLedger(p.items); // integer maths; throws on a negative net
  const buyerWallet = db.prepare("SELECT id FROM wallets WHERE owner = 'buyer'").get() as { id: number } | undefined;
  const coop = db.prepare("SELECT id, asset_code, asset_scale FROM wallets WHERE owner = 'cooperative'").get() as { id: number; asset_code: string; asset_scale: number } | undefined;
  if (!buyerWallet || !coop) throw new Error("Buyer or cooperative wallet is missing");

  return db.transaction(() => {
    const orderRef = p.orderRef ?? nextOrderRef(db);
    const orderId = Number(
      db
        .prepare(
          `INSERT INTO orders (order_ref, buyer_user_id, buyer_wallet_id, cooperative_wallet_id, expected_receive_minor, asset_code, asset_scale, origin)
           VALUES (?,?,?,?,?,?,?,?)`,
        )
        .run(orderRef, p.buyerUserId, buyerWallet.id, coop.id, ledger.grossMinor, coop.asset_code, coop.asset_scale, p.origin).lastInsertRowid,
    );
    const addItem = db.prepare("INSERT INTO order_items (order_id, farmer_id, produce, kg, price_minor_per_kg, gross_minor, asset_code, asset_scale) VALUES (?,?,?,?,?,?,?,?)");
    for (const i of p.items) addItem.run(orderId, i.farmerId, i.produce, i.kg, i.priceMinorPerKg, i.grossMinor, coop.asset_code, coop.asset_scale);

    const addAlloc = db.prepare(
      `INSERT INTO allocations (order_id, recipient, kind, gross_minor, fee_minor, deduction_minor, net_minor, asset_code, asset_scale) VALUES (?,?,?,?,?,?,?,?,?)`,
    );
    const farmerIds = [...new Set(p.items.map((i) => i.farmerId))];
    for (const f of farmerIds) {
      const mine = p.items.filter((i) => i.farmerId === f);
      const gross = mine.reduce((s, i) => s + i.grossMinor, 0);
      const fee = mine.reduce((s, i) => s + i.feeMinor, 0);
      const ded = mine.reduce((s, i) => s + i.deductionMinor, 0);
      addAlloc.run(orderId, f, "farmer", gross, fee, ded, gross - fee - ded, coop.asset_code, coop.asset_scale);
    }
    if (ledger.logisticsMinor > 0) addAlloc.run(orderId, "logistics", "logistics", ledger.logisticsMinor, 0, 0, ledger.logisticsMinor, coop.asset_code, coop.asset_scale);
    if (ledger.feesMinor > 0) addAlloc.run(orderId, "cooperative", "cooperative", ledger.feesMinor, 0, 0, ledger.feesMinor, coop.asset_code, coop.asset_scale);

    const total = (db.prepare("SELECT SUM(net_minor) s FROM allocations WHERE order_id = ?").get(orderId) as { s: number }).s;
    if (total !== ledger.grossMinor) throw new Error("Allocation total does not equal expected receive"); // rolls back
    audit(db, { actor: p.actorLabel, action: p.auditAction, entityType: "order", entityId: orderId, metadata: { orderRef, expectedReceiveMinor: ledger.grossMinor, origin: p.origin, lines: p.items.length } });
    return { orderId, orderRef, expectedReceiveMinor: ledger.grossMinor };
  })();
}

// ---------------------------------------------------------------------------
// Create order form
// ---------------------------------------------------------------------------

export const listBuyers = (db: Db) => db.prepare("SELECT id, name FROM users WHERE role = 'buyer' ORDER BY id").all() as { id: number; name: string }[];
export const listFarmerChoices = (db: Db) => db.prepare("SELECT owner AS id, public_name AS name FROM wallets WHERE owner LIKE 'farmer-%' ORDER BY owner").all() as { id: string; name: string }[];

/** What the form sends. Everything arrives as text/number from a browser, so it is parsed defensively. */
export type OrderRequest = { buyerUserId: unknown; lines: unknown; terms: unknown };
export type PlanResult = { ok: true; plan: OrderPlan; buyerUserId: number } | { ok: false; errors: string[] };

const asInt = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : null;
  if (typeof v === "string" && /^\d{1,15}$/.test(v.trim())) return Number(v.trim());
  return null;
};

export function planFromRequest(db: Db, body: OrderRequest): PlanResult {
  const errors: string[] = [];
  const buyerUserId = asInt(body?.buyerUserId);
  if (buyerUserId === null || !listBuyers(db).some((b) => b.id === buyerUserId)) errors.push("Choose a buyer");
  const farmers = new Set(listFarmerChoices(db).map((f) => f.id));
  const rawLines = Array.isArray(body?.lines) ? (body.lines as Record<string, unknown>[]) : [];
  const lines: PlanLine[] = [];
  rawLines.forEach((l, i) => {
    const n = i + 1;
    const farmerId = String(l?.farmerId ?? "");
    if (!farmers.has(farmerId)) errors.push(`Line ${n}: choose a farmer`);
    const kg = asInt(l?.kg);
    if (kg === null) errors.push(`Line ${n}: kg must be a whole number`);
    let price = 0;
    try {
      price = parseMajorToMinor(String(l?.price ?? ""), 2); // decimal text -> integer minor units, no floats
    } catch {
      errors.push(`Line ${n}: price per kg must be a number with at most 2 decimals, like 3.50`);
    }
    lines.push({ farmerId, produce: String(l?.produce ?? ""), kg: kg ?? 0, priceMinorPerKg: price });
  });
  const rawTerms = (body?.terms && typeof body.terms === "object" ? body.terms : {}) as Record<string, { fee?: unknown; deduction?: unknown }>;
  const terms: Record<string, PlanFarmerTerms> = {};
  for (const f of new Set(lines.map((l) => l.farmerId))) {
    const fee = asInt(rawTerms[f]?.fee);
    const ded = asInt(rawTerms[f]?.deduction);
    if (fee === null) errors.push(`${f}: service fee must be a whole number of minor units (0 or more)`);
    if (ded === null) errors.push(`${f}: logistics deduction must be a whole number of minor units (0 or more)`);
    terms[f] = { feeMinor: fee ?? 0, deductionMinor: ded ?? 0 };
  }
  if (errors.length) return { ok: false, errors };
  try {
    return { ok: true, plan: planOrder(lines, terms), buyerUserId: buyerUserId! };
  } catch (e) {
    if (e instanceof PlanError) return { ok: false, errors: e.errors };
    throw e;
  }
}

export function createOrder(db: Db, actor: PayActor, body: OrderRequest): InsertedOrder {
  if (actor.role !== "operator") throw new ForbiddenError("Only operators can create orders");
  const r = planFromRequest(db, body);
  if (!r.ok) throw new PaymentError(r.errors.join(" | "));
  return insertOrder(db, { buyerUserId: r.buyerUserId, items: r.plan.items, origin: "OPERATOR", actorLabel: who(actor), auditAction: "ORDER_CREATED" });
}

// ---------------------------------------------------------------------------
// Demo: a FRESH synthetic order. Never touches anything that already exists.
// ---------------------------------------------------------------------------
export const DEMO_MAX_MINOR = 100_000; // 1,000.00

export function createDemoOrder(db: Db, actor: PayActor, totalText: string): InsertedOrder {
  if (actor.role !== "operator") throw new ForbiddenError("Only operators can create demo orders");
  let total: number;
  try {
    total = parseMajorToMinor(totalText || "100.00", 2);
    if (total > DEMO_MAX_MINOR) throw new Error(`Demo total must be at most ${formatMinor(DEMO_MAX_MINOR, 2)}`);
  } catch (e) {
    throw new PaymentError(e instanceof Error ? e.message : "Invalid total");
  }
  let items: DemoItem[];
  try {
    items = buildDemoOrder(total); // worked example scaled to the chosen total (multiples of 10.00)
  } catch (e) {
    throw new PaymentError(e instanceof Error ? e.message : "Invalid total");
  }
  const buyer = (db.prepare("SELECT id FROM users WHERE username = 'buyer'").get() ?? db.prepare("SELECT id FROM users WHERE role = 'buyer' ORDER BY id LIMIT 1").get()) as { id: number } | undefined;
  if (!buyer) throw new PaymentError("No buyer user exists");
  return insertOrder(db, { buyerUserId: buyer.id, items, origin: "DEMO_RESET", actorLabel: who(actor), auditAction: "DEMO_ORDER_CREATED" });
}

// ---------------------------------------------------------------------------
// Strict shape check for the Create order request (unknown fields and wrong types are refused, not ignored)
// ---------------------------------------------------------------------------
const intOrText = (v: unknown, where: string, maxLen = 20) => {
  if (typeof v === "number" ? !Number.isSafeInteger(v) : typeof v !== "string" || v.length > maxLen) throw new BadRequestError(`${where} has the wrong type`);
};

export function strictOrderRequest(raw: unknown): OrderRequest {
  if (!isPlainObject(raw)) throw new BadRequestError("Body must be an object");
  onlyKeys(raw, ["buyerUserId", "lines", "terms"], "order");
  if (typeof raw.buyerUserId !== "number" || !Number.isSafeInteger(raw.buyerUserId)) throw new BadRequestError("buyerUserId must be a whole number");
  if (!Array.isArray(raw.lines) || raw.lines.length > 20) throw new BadRequestError("lines must be a list of at most 20");
  raw.lines.forEach((l, i) => {
    if (!isPlainObject(l)) throw new BadRequestError(`Line ${i + 1} must be an object`);
    onlyKeys(l, ["farmerId", "produce", "kg", "price"], `line ${i + 1}`);
    if (typeof l.farmerId !== "string" || l.farmerId.length > 40) throw new BadRequestError(`Line ${i + 1}: farmerId has the wrong type`);
    if (typeof l.produce !== "string" || l.produce.length > 200) throw new BadRequestError(`Line ${i + 1}: produce has the wrong type`);
    intOrText(l.kg, `Line ${i + 1}: kg`);
    if (typeof l.price !== "string" || l.price.length > 20) throw new BadRequestError(`Line ${i + 1}: price must be text like 3.50`);
  });
  if (!isPlainObject(raw.terms) || Object.keys(raw.terms).length > 20) throw new BadRequestError("terms must be an object");
  for (const [f, t] of Object.entries(raw.terms)) {
    if (f.length > 40 || !isPlainObject(t)) throw new BadRequestError("terms entries must be objects");
    onlyKeys(t, ["fee", "deduction"], `terms for ${f}`);
    intOrText(t.fee, `${f}: fee`);
    intOrText(t.deduction, `${f}: deduction`);
  }
  return raw as OrderRequest;
}
