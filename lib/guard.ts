// Request guards shared by every route: CSRF (origin check), rate limit, strict input parsing.
import { NextResponse } from "next/server";
import { LIMITS, type LimitName } from "./limits";
import { allow } from "./rate-limit";

export * from "./validate";

const appHost = () => {
  try {
    return new URL(process.env.APP_BASE_URL?.trim() || "http://localhost:3000").host;
  } catch {
    return "localhost:3000";
  }
};

/**
 * CSRF check for state-changing requests. The request must come from this app:
 * its Origin (or, if the browser sent none, its Referer) must be this site, by the Host header or APP_BASE_URL.
 * No Origin and no Referer at all is refused, and so is a browser saying Sec-Fetch-Site: cross-site.
 */
export function sameSite(req: Request): boolean {
  const host = req.headers.get("host");
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site" || fetchSite === "same-site") return false;
  const source = req.headers.get("origin") ?? req.headers.get("referer");
  if (!source || source === "null") return false;
  try {
    const h = new URL(source).host;
    return h === host || h === appHost();
  } catch {
    return false;
  }
}

/** Rate limit by name (see lib/limits.ts). Returns a Response to send, or null to continue. */
export function rateLimited(name: LimitName, key: string): Response | null {
  const l = LIMITS[name];
  if (allow(`${name}:${key}`, l.max, l.windowMs)) return null;
  return NextResponse.json({ error: "Too many requests, wait a minute" }, { status: 429, headers: { "Retry-After": "60" } });
}

