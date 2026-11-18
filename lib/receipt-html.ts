// The public receipt page (served at /r/<token>). Plain HTML, mobile first, no scripts, no external requests.
// Shows ONE recipient's receipt only: no wallet address, no phone number, no other recipients.
import type { Db } from "./db";
import { LIMITS } from "./limits";
import { allow } from "./rate-limit";
import type { Receipt } from "./receipt";
import { resolveReceiptLink } from "./receipt-links";

export const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** Headers for every response on this route: never cached, never indexed, never leaks the URL as a referrer. */
export function receiptHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    Pragma: "no-cache",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

const page = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive"><meta name="referrer" content="no-referrer"><title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;color:#000;background:#fff}
.banner{background:#fde047;border-bottom:2px solid #000;padding:8px 16px;text-align:center;font-weight:700;font-size:14px;text-transform:uppercase}
main{max-width:480px;margin:0 auto;padding:16px}
.amount{font-size:44px;font-weight:700;line-height:1.1;margin:8px 0}
.status{font-size:24px;font-weight:700;margin:4px 0 16px}
dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 16px;font-size:18px}dt{color:#444}dd{margin:0;text-align:right}
pre{background:#f3f4f6;border:1px solid #000;padding:12px;font-size:16px;white-space:pre-wrap}
small{color:#444}
</style></head><body><div class="banner">TEST NETWORK, PLAY MONEY ONLY</div><main>${body}</main></body></html>`;

export function renderReceiptPage(r: Receipt, expiresAt: string): string {
  return page(
    "Payment receipt",
    `<p>Order ${escapeHtml(r.orderRef)}</p>
<div>You ${r.state === "CONFIRMED" ? "got" : "will get"}</div>
<div class="amount">${escapeHtml(r.amountText)}</div>
<div class="status">${escapeHtml(r.statusWords)}</div>
<dl>
<dt>Gross</dt><dd>${escapeHtml(r.grossText)}</dd>
<dt>Fee</dt><dd>${escapeHtml(r.feeText)}</dd>
<dt>Logistics deduction</dt><dd>${escapeHtml(r.deductionText)}</dd>
<dt>Net</dt><dd><strong>${escapeHtml(r.netText)}</strong></dd>
<dt>Reference</dt><dd>${escapeHtml(r.reference)}</dd>
</dl>
<h2>Text version</h2>
<pre>${escapeHtml(r.text)}</pre>
<p><small>This is a test-network receipt with play money. This link stops working on ${escapeHtml(expiresAt.replace("T", " ").slice(0, 16))} UTC or when the operator revokes it.</small></p>`,
  );
}

export const renderNotFoundPage = () =>
  page("Receipt not available", `<h1>This receipt link is not available</h1><p>It may have expired or been withdrawn. Please ask your operator for a new one.</p>`);

export type PublicResponse = { status: number; html: string; headers: Record<string, string> };

/** Everything the public route does, kept here so it can be tested without a server. */
export function handleReceiptRequest(db: Db, token: string, clientKey: string, now = Date.now()): PublicResponse {
  const headers = receiptHeaders();
  if (!allow(`receipt:${clientKey}`, LIMITS.receiptPublic.max, LIMITS.receiptPublic.windowMs, now)) {
    return { status: 429, html: page("Slow down", "<h1>Too many requests</h1><p>Please wait a minute and try again.</p>"), headers };
  }
  const r = resolveReceiptLink(db, token, now);
  // Unknown, malformed, expired and revoked links all look exactly the same.
  if (!r.ok) return { status: 404, html: renderNotFoundPage(), headers };
  return { status: 200, html: renderReceiptPage(r.receipt, r.expiresAt), headers };
}
