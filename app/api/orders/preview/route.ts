import { NextResponse } from "next/server";
import { withRole } from "../../../../lib/auth";
import { getDb } from "../../../../lib/db";
import { readJson } from "../../../../lib/guard";
import { formatMinor } from "../../../../lib/money";
import { planFromRequest, strictOrderRequest } from "../../../../lib/orders";

// Operator only. Computes the allocation table for the Create order form. Saves nothing.
export const POST = withRole<unknown>(
  ["operator"],
  async (_actor, req) => {
    const r = planFromRequest(getDb(), strictOrderRequest(await readJson(req)));
    if (!r.ok) return NextResponse.json({ ok: false, errors: r.errors });
    const t = (n: number) => `${formatMinor(n, 2)} USD`;
    const p = r.plan;
    return NextResponse.json({
      ok: true,
      lines: p.items.map((i) => ({ farmerId: i.farmerId, produce: i.produce, kg: i.kg, price: t(i.priceMinorPerKg), gross: t(i.grossMinor) })),
      farmers: p.farmers.map((f) => ({ farmerId: f.farmerId, gross: t(f.grossMinor), fee: t(f.feeMinor), deduction: t(f.deductionMinor), net: t(f.netMinor) })),
      logistics: t(p.logisticsMinor), retained: t(p.retainedMinor), expectedReceive: t(p.expectedReceiveMinor), farmerNets: t(p.ledger.farmerNetsMinor),
      ledgerTotal: t(p.ledger.totalMinor),
    });
  },
  { limit: "orderPreview" },
);
