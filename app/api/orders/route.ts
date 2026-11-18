import { NextResponse } from "next/server";
import { listOrders } from "../../../lib/access";
import { withRole } from "../../../lib/auth";
import { getDb } from "../../../lib/db";

// Operator: all orders. Buyer: only their own. Farmers are refused by the guard.
export const GET = withRole<unknown>(["operator", "buyer"], (actor) => NextResponse.json({ orders: listOrders(getDb(), actor) }));
