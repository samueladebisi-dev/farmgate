"use server";
// Login / logout server actions.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { audit } from "../lib/audit";
import { homeFor } from "../lib/auth";
import { getDb } from "../lib/db";
import { verifyPassword } from "../lib/password";
import { createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../lib/session";

export async function loginAction(_prev: { error?: string } | undefined, form: FormData): Promise<{ error?: string }> {
  const username = String(form.get("username") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  const db = getDb();
  const u = db.prepare("SELECT id, role, password_hash FROM users WHERE username = ?").get(username) as
    | { id: number; role: "buyer" | "operator" | "farmer"; password_hash: string }
    | undefined;
  // Same message for unknown user and wrong password.
  if (!u || !verifyPassword(password, u.password_hash)) {
    audit(db, { actor: username || "unknown", action: "login.failed", entityType: "user", entityId: username || "unknown" });
    return { error: "Wrong username or password" };
  }
  const jar = await cookies();
  jar.set(SESSION_COOKIE, createSessionToken(u.id), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  audit(db, { actor: username, action: "login.ok", entityType: "user", entityId: u.id });
  redirect(homeFor(u.role));
}

export async function logoutAction() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
