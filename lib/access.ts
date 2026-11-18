// Access-controlled data reads. Every page and API route reads data through these, so the
// rules (e.g. a farmer only ever sees their own record) live in ONE place and are tested.
import type { Db } from "./db";
import { NO_PAYOUT_WORDS, STATE_WORDS, type PayoutState } from "./payout-state";

export type Role = "buyer" | "operator" | "farmer";
export type Actor = { id: number; role: Role; name: string; linkedFarmerId: string | null };

export class ForbiddenError extends Error {
  status = 403;
}
export class NotFoundError extends Error {
  status = 404;
}

type Money = { minor: number; assetCode: string; assetScale: number };

export type OrderRow = {
  id: number;
  orderRef: string;
  buyerName: string;
  status: string;
  version: number;
  expected: Money;
  confirmedReceivedMinor: number | null;
  buyerWallet: { url: string; assetCode: string; assetScale: number };
  coopWallet: { url: string; assetCode: string; assetScale: number };
};

export type ItemRow = { farmerId: string; farmerName: string; produce: string; kg: number; priceMinorPerKg: number; gross: Money };

export type AllocationRow = {
  recipient: string;
  recipientName: string;
  kind: "farmer" | "logistics" | "cooperative";
  gross: Money;
  feeMinor: number;
  deductionMinor: number;
  net: Money;
  approvalVersion: number;
  payoutState: PayoutState | null;
  dashboardWords: string;
  farmerWords: string;
};

const ORDER_SQL = `
  SELECT o.id, o.order_ref, o.status, o.version, o.expected_receive_minor, o.confirmed_received_minor,
         o.asset_code, o.asset_scale, u.name AS buyer_name, o.buyer_user_id,
         bw.canonical_url AS bw_url, bw.asset_code AS bw_code, bw.asset_scale AS bw_scale,
         cw.canonical_url AS cw_url, cw.asset_code AS cw_code, cw.asset_scale AS cw_scale
  FROM orders o
  JOIN users u ON u.id = o.buyer_user_id
  JOIN wallets bw ON bw.id = o.buyer_wallet_id
  JOIN wallets cw ON cw.id = o.cooperative_wallet_id`;

type RawOrder = {
  id: number; order_ref: string; status: string; version: number; expected_receive_minor: number;
  confirmed_received_minor: number | null; asset_code: string; asset_scale: number; buyer_name: string; buyer_user_id: number;
  bw_url: string; bw_code: string; bw_scale: number; cw_url: string; cw_code: string; cw_scale: number;
};

function toOrder(r: RawOrder): OrderRow {
  return {
    id: r.id, orderRef: r.order_ref, buyerName: r.buyer_name, status: r.status, version: r.version,
    expected: { minor: r.expected_receive_minor, assetCode: r.asset_code, assetScale: r.asset_scale },
    confirmedReceivedMinor: r.confirmed_received_minor,
    buyerWallet: { url: r.bw_url, assetCode: r.bw_code, assetScale: r.bw_scale },
    coopWallet: { url: r.cw_url, assetCode: r.cw_code, assetScale: r.cw_scale },
  };
}

/** Operators see all orders, buyers only their own. Farmers see no order-level data at all. */
export function listOrders(db: Db, actor: Actor): OrderRow[] {
  if (actor.role === "operator") return (db.prepare(`${ORDER_SQL} ORDER BY o.id`).all() as RawOrder[]).map(toOrder);
  if (actor.role === "buyer") {
    return (db.prepare(`${ORDER_SQL} WHERE o.buyer_user_id = ? ORDER BY o.id`).all(actor.id) as RawOrder[]).map(toOrder);
  }
  throw new ForbiddenError("Farmers cannot read orders");
}

function farmerName(db: Db, farmerId: string): string {
  const r = db.prepare("SELECT public_name FROM wallets WHERE owner = ?").get(farmerId) as { public_name: string } | undefined;
  return r?.public_name ?? farmerId;
}

export function getOrderItems(db: Db, actor: Actor, orderId: number): ItemRow[] {
  const order = listOrders(db, actor).find((o) => o.id === orderId);
  if (!order) throw new NotFoundError("Order not found");
  const rows = db
    .prepare("SELECT farmer_id, produce, kg, price_minor_per_kg, gross_minor, asset_code, asset_scale FROM order_items WHERE order_id = ? ORDER BY id")
    .all(orderId) as { farmer_id: string; produce: string; kg: number; price_minor_per_kg: number; gross_minor: number; asset_code: string; asset_scale: number }[];
  return rows.map((r) => ({
    farmerId: r.farmer_id, farmerName: farmerName(db, r.farmer_id), produce: r.produce, kg: r.kg,
    priceMinorPerKg: r.price_minor_per_kg,
    gross: { minor: r.gross_minor, assetCode: r.asset_code, assetScale: r.asset_scale },
  }));
}

type RawAlloc = {
  id: number; recipient: string; kind: AllocationRow["kind"]; gross_minor: number; fee_minor: number; deduction_minor: number;
  net_minor: number; asset_code: string; asset_scale: number; approval_version: number; state: PayoutState | null;
};

function toAllocation(db: Db, r: RawAlloc): AllocationRow {
  const words = r.state ? STATE_WORDS[r.state] : NO_PAYOUT_WORDS;
  return {
    recipient: r.recipient, recipientName: farmerName(db, r.recipient), kind: r.kind,
    gross: { minor: r.gross_minor, assetCode: r.asset_code, assetScale: r.asset_scale },
    feeMinor: r.fee_minor, deductionMinor: r.deduction_minor,
    net: { minor: r.net_minor, assetCode: r.asset_code, assetScale: r.asset_scale },
    approvalVersion: r.approval_version, payoutState: r.state,
    dashboardWords: words.dashboard, farmerWords: words.farmer,
  };
}

const ALLOC_SQL = `
  SELECT a.id, a.recipient, a.kind, a.gross_minor, a.fee_minor, a.deduction_minor, a.net_minor,
         a.asset_code, a.asset_scale, a.approval_version,
         (SELECT p.state FROM payout_operations p WHERE p.allocation_id = a.id ORDER BY p.approval_version DESC, p.id DESC LIMIT 1) AS state
  FROM allocations a`;

/** Full allocation table: operator only. */
export function getAllocations(db: Db, actor: Actor, orderId: number): AllocationRow[] {
  if (actor.role !== "operator") throw new ForbiddenError("Only operators can read the allocation table");
  return (db.prepare(`${ALLOC_SQL} WHERE a.order_id = ? ORDER BY a.id`).all(orderId) as RawAlloc[]).map((r) => toAllocation(db, r));
}

export type FarmerRecord = { farmerId: string; farmerName: string; orderRef: string; items: ItemRow[]; allocation: AllocationRow | null };

/**
 * A farmer's own record. Allowed for: the operator, and the farmer whose linked_farmer_id matches.
 * Any other farmer (or a buyer) gets ForbiddenError.
 */
export function getFarmerRecord(db: Db, actor: Actor, farmerId: string): FarmerRecord[] {
  const allowed = actor.role === "operator" || (actor.role === "farmer" && actor.linkedFarmerId === farmerId);
  if (!allowed) throw new ForbiddenError("You can only read your own record");
  const orders = db.prepare("SELECT id, order_ref FROM orders ORDER BY id").all() as { id: number; order_ref: string }[];
  const out: FarmerRecord[] = [];
  for (const o of orders) {
    const items = (
      db.prepare("SELECT produce, kg, price_minor_per_kg, gross_minor, asset_code, asset_scale FROM order_items WHERE order_id = ? AND farmer_id = ? ORDER BY id").all(o.id, farmerId) as
        { produce: string; kg: number; price_minor_per_kg: number; gross_minor: number; asset_code: string; asset_scale: number }[]
    ).map((r) => ({
      farmerId, farmerName: farmerName(db, farmerId), produce: r.produce, kg: r.kg, priceMinorPerKg: r.price_minor_per_kg,
      gross: { minor: r.gross_minor, assetCode: r.asset_code, assetScale: r.asset_scale },
    }));
    if (items.length === 0) continue;
    const raw = db.prepare(`${ALLOC_SQL} WHERE a.order_id = ? AND a.recipient = ?`).get(o.id, farmerId) as RawAlloc | undefined;
    out.push({ farmerId, farmerName: farmerName(db, farmerId), orderRef: o.order_ref, items, allocation: raw ? toAllocation(db, raw) : null });
  }
  return out;
}
