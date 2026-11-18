import { getDb } from "../../../lib/db";
import { handleReceiptRequest } from "../../../lib/receipt-html";

export const dynamic = "force-dynamic";

// Public receipt for ONE recipient. No login. Expiry and revocation are checked on the server on every request.
export async function GET(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const ip = (req.headers.get("x-forwarded-for") ?? "local").split(",")[0].trim();
  const r = handleReceiptRequest(getDb(), token, ip);
  return new Response(r.html, { status: r.status, headers: r.headers });
}
