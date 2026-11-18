// Small helpers shared by the routes: dependencies, redirects, and the wrapper for operator-only actions.
import { NextResponse } from "next/server";
import { withRole, type SessionActor } from "./auth";
import { getDb, type Db } from "./db";
import { idParam, readForm } from "./guard";
import type { LimitName } from "./limits";
import { PaymentError, type Deps } from "./payments";
import { getProvider } from "./provider";

export function getDeps(): Deps {
  return { db: getDb(), provider: getProvider(), appBaseUrl: process.env.APP_BASE_URL?.trim() || "http://localhost:3000" };
}

/** See-other redirect (303) so a form POST lands on a normal GET page. */
export function redirectTo(req: Request, path: string): Response {
  return NextResponse.redirect(new URL(path, req.url), 303);
}

/** Redirect back to a page with either a notice code or a pointer to the audit row explaining the failure. */
export function noticeRedirect(req: Request, base: string, notice: string, err?: unknown): Response {
  const q = new URLSearchParams({ notice });
  if (err instanceof PaymentError && err.auditId) q.set("ref", String(err.auditId));
  return redirectTo(req, `${base}?${q}`);
}

type FormSpec = Record<string, { re: RegExp; optional?: boolean }>;

/**
 * Wrapper for operator-only POST actions: role guard, same-site check, rate limit, strict form parsing
 * (ONLY the fields in `form` are accepted, default none), error-to-notice mapping.
 * `run` returns a notice code (shown on the order page) or a Response (e.g. a redirect to the wallet).
 */
export function operatorAction<C extends { params: Promise<{ id: string }> }>(
  limit: LimitName,
  run: (d: Deps, actor: SessionActor, id: number, fields: Record<string, string | undefined>, req: Request) => Promise<string | Response>,
  opts: {
    form?: FormSpec;
    /** Which order page to come back to. Default: the id in the URL IS the order id. */
    orderOf?: (db: Db, id: number) => number | null;
  } = {},
) {
  return withRole<C>(
    ["operator"],
    async (actor, req, ctx) => {
      const id = idParam((await ctx.params).id);
      const fields = await readForm(req, opts.form ?? {});
      const back = () => {
        const orderId = opts.orderOf ? opts.orderOf(getDb(), id) : id;
        return orderId ? `/operator/orders/${orderId}` : "/operator";
      };
      try {
        const r = await run(getDeps(), actor, id, fields, req);
        return typeof r === "string" ? noticeRedirect(req, back(), r) : r;
      } catch (e) {
        if (e instanceof PaymentError) return noticeRedirect(req, back(), "error", e);
        throw e;
      }
    },
    { limit },
  );
}
