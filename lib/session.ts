// Signed-cookie session: value = base64url(JSON payload) + "." + HMAC-SHA256 signature.
// Pure functions (no Next imports) so they can be tested directly.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type SessionPayload = { uid: number; sid: string; exp: number }; // exp = unix seconds

export const SESSION_COOKIE = "argus_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("SESSION_SECRET is missing or too short (see .env.example)");
  return s;
}

const sign = (data: string, key: string) => createHmac("sha256", key).update(data).digest("base64url");

export function createSessionToken(uid: number, now = Date.now(), key = secret(), sid: string = randomBytes(16).toString("hex")): string {
  const payload: SessionPayload = { uid, sid, exp: Math.floor(now / 1000) + SESSION_TTL_SECONDS };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

/** Returns the payload if the signature is valid and not expired, otherwise null. */
export function readSessionToken(token: string | undefined, now = Date.now(), key = secret()): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(body, key));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
    if (!Number.isInteger(p.uid) || typeof p.sid !== "string" || p.exp * 1000 < now) return null;
    return p;
  } catch {
    return null;
  }
}

/**
 * The session cookie must be Secure everywhere except plain localhost development
 * (browsers do not send Secure cookies over http, so localhost is the one exception).
 */
export function cookieSecure(appBaseUrl: string | undefined): boolean {
  try {
    const host = new URL(appBaseUrl || "http://localhost:3000").hostname;
    return !(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1");
  } catch {
    return true; // if the address cannot be read, be safe
  }
}
