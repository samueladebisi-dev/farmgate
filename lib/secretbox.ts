// Encrypts provider tokens before they touch the database (AES-256-GCM).
// The key is derived from SESSION_SECRET, which lives only in .env on the server.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

function key(k?: string): Buffer {
  const secret = k ?? process.env.SESSION_SECRET;
  if (!secret || secret.length < 16) throw new Error("SESSION_SECRET is missing or too short");
  return createHash("sha256").update(`token-box:${secret}`).digest();
}

export function seal(plain: string, k?: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(k), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
}

export function open(sealed: string, k?: string): string {
  const raw = Buffer.from(sealed, "base64");
  const d = createDecipheriv("aes-256-gcm", key(k), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString("utf8");
}
