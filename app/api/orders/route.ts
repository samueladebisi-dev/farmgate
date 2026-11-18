import { NextResponse } from "next/server";
import { listOrders } from "../../../lib/access";
import { withRole } from "../../../lib/auth";
import { getDb } from "../../../lib/db";
import { readJson } from "../../../lib/guard";
import { createOrder, strictOrderRequest } from "../../../lib/orders";
import { PaymentError } from "../../../lib/payments";

// Operator: all orders. Buyer: only their own. Farmers are refused by the guard.
export const GET = withRole<unknown>(["operator", "buyer"], (actor) => NextResponse.json({ orders: listOrders(getDb(), actor) }), { limit: "read" });

// Operator only: create an order (same validation as the preview, repeated here because the browser is never trusted).
export const POST = withRole<unknown>(
  ["operator"],
  async (actor, req) => {
    const body = strictOrderRequest(await readJson(req));
    try {
      const o = createOrder(getDb(), actor, body);
      return NextResponse.json({ ok: true, orderId: o.orderId, orderRef: o.orderRef });
    } catch (e) {
      if (e instanceof PaymentError) return NextResponse.json({ ok: false, errors: e.message.split(" | ") }, { status: 400 });
      throw e;
    }
  },
  { limit: "orderCreate" },
);
