// Server-side auth helpers + the role guard that EVERY page and API route uses.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { ForbiddenError, NotFoundError, type Actor, type Role } from "./access";
import { getDb } from "./db";
import { readSessionToken, SESSION_COOKIE } from "./session";

export type SessionActor = Actor & { sessionId: string };

/** The logged-in user, or null. */
export async function getActor(): Promise<SessionActor | null> {
  const jar = await cookies();
  const session = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const u = getDb().prepare("SELECT id, role, name, linked_farmer_id FROM users WHERE id = ?").get(session.uid) as
    | { id: number; role: Role; name: string; linked_farmer_id: string | null }
    | undefined;
  if (!u) return null;
  return { id: u.id, role: u.role, name: u.name, linkedFarmerId: u.linked_farmer_id, sessionId: session.sid };
}

export function homeFor(role: Role): string {
  return role === "operator" ? "/operator" : role === "buyer" ? "/buyer" : "/farmer";
}

/** For pages: send to /login if signed out, or to the user's own home if their role is not allowed. */
export async function requirePage(roles: Role[]): Promise<SessionActor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  if (!roles.includes(actor.role)) redirect(homeFor(actor.role));
  return actor;
}

/** For API routes: wraps a handler so it only runs for allowed roles; maps access errors to 401/403/404. */
export function withRole<C>(roles: Role[], handler: (actor: SessionActor, req: Request, ctx: C) => Promise<Response> | Response) {
  return async (req: Request, ctx: C): Promise<Response> => {
    const actor = await getActor();
    if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    if (!roles.includes(actor.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    try {
      return await handler(actor, req, ctx);
    } catch (e) {
      if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
      if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
      throw e;
    }
  };
}
