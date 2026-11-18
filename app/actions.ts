"use server";
// Login / logout server actions. (Next.js itself refuses cross-site calls to server actions by comparing Origin and Host.)
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "../lib/audit";
import { homeFor } from "../lib/auth";
import { getDb } from "../lib/db";
import { authenticate } from "../lib/login";
import { cookieSecure, readSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../lib/session";
import { issueSession, revokeSession } from "../lib/session-store";

export async function loginAction(_prev: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "local").split(",")[0].trim().slice(0, 64);
  const db = getDb();
  const r = authenticate(db, { username: form.get("username"), password: form.get("password"), ip });
  // Same message for unknown user and wrong password.
  if (!r.ok) return { error: r.reason === "RATE_LIMITED" ? "Too many attempts. Wait a minute and try again." : "Wrong username or password" };
  const { token } = issueSession(db, r.userId);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(process.env.APP_BASE_URL),
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  audit(db, { actor: `user:${r.userId}`, action: "login.ok", entityType: "user", entityId: r.userId });
  redirect(homeFor(r.role));
}

export async function logoutAction() {
  const jar = await cookies();
  const p = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (p) {
    revokeSession(getDb(), p.sid); // the cookie is dead on the server, not just removed from this browser
    audit(getDb(), { actor: `user:${p.uid}`, action: "logout", entityType: "user", entityId: p.uid });
  }
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
