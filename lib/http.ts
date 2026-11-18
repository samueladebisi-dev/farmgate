// Small helpers shared by the payment routes: dependencies, CSRF-ish origin check, rate limit, redirects.
import { NextResponse } from "next/server";
import { getDb } from "./db";
import { PaymentError, type Deps } from "./payments";
import { getProvider } from "./provider";
import { allow } from "./rate-limit";

export function getDeps(): Deps {
  return { db: getDb(), provider: getProvider(), appBaseUrl: process.env.APP_BASE_URL?.trim() || "http://localhost:3000" };
}

/** Refuse cross-site form posts and over-eager callers. Returns a Response to send, or null to continue. */
export function guardRequest(req: Request, userKey: string, bucket: string, max = 10): Response | null {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host && new URL(origin).host !== host) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  if (!allow(`${bucket}:${userKey}`, max, 60_000)) return NextResponse.json({ error: "Too many requests, wait a minute" }, { status: 429 });
  return null;
}

/** See-other redirect (303) so a form POST lands on a normal GET page. */
export function redirectTo(req: Request, path: string): Response {
  return NextResponse.redirect(new URL(path, req.url), 303);
}

/** Redirect back to the buyer page with either a notice code or a pointer to the audit row explaining the failure. */
export function noticeRedirect(req: Request, base: string, notice: string, err?: unknown): Response {
  const q = new URLSearchParams({ notice });
  if (err instanceof PaymentError && err.auditId) q.set("ref", String(err.auditId));
  return redirectTo(req, `${base}?${q}`);
}
