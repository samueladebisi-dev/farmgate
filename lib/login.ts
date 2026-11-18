// Login check with brute-force protection. Kept free of Next.js so it can be tested directly.
import { audit } from "./audit";
import type { Db } from "./db";
import { LIMITS } from "./limits";
import { hashPassword, verifyPassword } from "./password";
import { allow } from "./rate-limit";
import type { Role } from "./access";

// Checked against when the username does not exist, so a missing user takes as long as a wrong password.
const DUMMY_HASH = hashPassword("not-a-real-password");

export type LoginResult = { ok: true; userId: number; role: Role } | { ok: false; reason: "RATE_LIMITED" | "INVALID" };

export function authenticate(db: Db, input: { username: unknown; password: unknown; ip: string }, now = Date.now()): LoginResult {
  const username = typeof input.username === "string" ? input.username.trim().toLowerCase().slice(0, 64) : "";
  const password = typeof input.password === "string" ? input.password.slice(0, 200) : "";
  // Count every attempt, per username and per address, BEFORE doing the expensive password check.
  const okUser = allow(`login-user:${username}`, LIMITS.loginUser.max, LIMITS.loginUser.windowMs, now);
  const okIp = allow(`login-ip:${input.ip}`, LIMITS.loginIp.max, LIMITS.loginIp.windowMs, now);
  if (!okUser || !okIp) {
    audit(db, { actor: username || "unknown", action: "login.rate_limited", entityType: "user", entityId: username || "unknown", metadata: { by: okUser ? "address" : "username" } });
    return { ok: false, reason: "RATE_LIMITED" };
  }
  const u = db.prepare("SELECT id, role, password_hash FROM users WHERE username = ?").get(username) as { id: number; role: Role; password_hash: string } | undefined;
  const good = verifyPassword(password, u?.password_hash ?? DUMMY_HASH) && !!u;
  if (!good) {
    audit(db, { actor: username || "unknown", action: "login.failed", entityType: "user", entityId: username || "unknown" });
    return { ok: false, reason: "INVALID" };
  }
  return { ok: true, userId: u!.id, role: u!.role };
}
