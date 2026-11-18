// Server-side session list. A cookie is only valid while its row exists, is not revoked and has not expired.
import { randomBytes } from "node:crypto";
import type { Db } from "./db";
import { createSessionToken, readSessionToken, SESSION_TTL_SECONDS, type SessionPayload } from "./session";

/** Create a session row and the signed cookie value that points at it. */
export function issueSession(db: Db, userId: number, now = Date.now()): { token: string; sid: string } {
  const sid = randomBytes(16).toString("hex");
  db.prepare("INSERT INTO sessions (sid, user_id, created_at, expires_at) VALUES (?,?,?,?)").run(
    sid, userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
  );
  // Old, finished sessions are tidied up as a side effect (never anything the audit log depends on).
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(new Date(now - 86_400_000).toISOString());
  return { token: createSessionToken(userId, now, undefined, sid), sid };
}

/** The payload if the cookie is genuine AND the server still considers the session alive; otherwise null. */
export function activeSession(db: Db, token: string | undefined, now = Date.now()): SessionPayload | null {
  const p = readSessionToken(token, now);
  if (!p) return null;
  const row = db.prepare("SELECT 1 AS ok FROM sessions WHERE sid = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?").get(p.sid, p.uid, new Date(now).toISOString());
  return row ? p : null;
}

/** Log out for real: the same cookie will never work again. */
export function revokeSession(db: Db, sid: string, now = Date.now()): void {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE sid = ? AND revoked_at IS NULL").run(new Date(now).toISOString(), sid);
}
