import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { withRole } from "../../../../../lib/auth";
import { getDb } from "../../../../../lib/db";
import { BadRequestError, idParam, isPlainObject, onlyKeys, readJson } from "../../../../../lib/guard";
import { createReceiptLink } from "../../../../../lib/receipt-links";

// Operator only. Creates a link for ONE recipient and returns it (with a QR code as SVG) exactly once:
// only a hash of the token is stored, so the link cannot be shown again.
export const POST = withRole<{ params: Promise<{ id: string }> }>(
  ["operator"],
  async (actor, req, ctx) => {
    const orderId = idParam((await ctx.params).id);
    const body = await readJson(req);
    if (!isPlainObject(body)) throw new BadRequestError("Body must be an object");
    onlyKeys(body, ["allocationId", "hours"], "receipt link");
    if (typeof body.allocationId !== "number" || !Number.isSafeInteger(body.allocationId) || body.allocationId < 1) throw new BadRequestError("allocationId must be a whole number");
    if (body.hours !== undefined && (typeof body.hours !== "number" || !Number.isSafeInteger(body.hours) || body.hours < 1 || body.hours > 24)) throw new BadRequestError("hours must be a whole number from 1 to 24");
    const link = createReceiptLink(getDb(), process.env.APP_BASE_URL?.trim() || "http://localhost:3000", actor, orderId, body.allocationId, body.hours);
    const qrSvg = await QRCode.toString(link.url, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return NextResponse.json({ id: link.id, url: link.url, expiresAt: link.expiresAt, hours: link.hours, qrSvg }, { headers: { "Cache-Control": "no-store" } });
  },
  { limit: "receiptLink" },
);
