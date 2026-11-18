// Server-side auth helpers + the role guard that EVERY page and API route uses.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { redirect } from "next/navigation";
import { ForbiddenError, NotFoundError, type Actor, type Role } from "./access";
import { getDb } from "./db";
import { BadRequestError, rateLimited, rejectQuery, sameSite } from "./guard";
import type { LimitName } from "./limits";
import { SESSION_COOKIE } from "./session";
import { activeSession } from "./session-store";

export type SessionActor = Actor & { sessionId: string };

/** The logged-in user, or null. The session must be alive on the server (logout and expiry really end it). */
export async function getActor(): Promise<SessionActor | null> {
  const jar = await cookies();
  const db = getDb();
  const session = activeSession(db, jar.get(SESSION_COOKIE)?.value);
  if (!session) return null;
  const u = db.prepare("SELECT id, role, name, linked_farmer_id FROM users WHERE id = ?").get(session.uid) as
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

export type RouteOptions = {
  /** Which rate limit from lib/limits.ts applies. Required: no route is left unlimited. */
  limit: LimitName;
  /** Query strings are refused unless a route says it needs them. */
  allowQuery?: boolean;
};

/**
 * For API routes. In this order: signed in? (401) allowed role? (403) same-site request for anything that changes
 * data? (403) no stray query string (400) rate limit (429), then the handler. Access and input errors become 403/404/400.
 */
export function withRole<C>(roles: Role[], handler: (actor: SessionActor, req: Request, ctx: C) => Promise<Response> | Response, opts: RouteOptions) {
  return async (req: Request, ctx: C): Promise<Response> => {
    const actor = await getActor();
    if (!actor) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
    if (!roles.includes(actor.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const changesData = req.method !== "GET" && req.method !== "HEAD";
    if (changesData && !sameSite(req)) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
    const limited = rateLimited(opts.limit, String(actor.id));
    if (limited) return limited;
    try {
      if (!opts.allowQuery) rejectQuery(req);
      return await handler(actor, req, ctx);
    } catch (e) {
      if (e instanceof BadRequestError) return NextResponse.json({ error: e.message }, { status: 400 });
      if (e instanceof ForbiddenError) return NextResponse.json({ error: e.message }, { status: 403 });
      if (e instanceof NotFoundError) return NextResponse.json({ error: e.message }, { status: 404 });
      throw e;
    }
  };
}
