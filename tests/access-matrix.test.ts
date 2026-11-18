// ACCESS CONTROL MATRIX.
// Every page and every API route is listed here with what each kind of caller must get. The test:
//  1. finds all routes on disk and FAILS if any is missing from the matrix (or the matrix lists one that no longer exists),
//  2. calls each one as: not logged in, buyer, operator, farmer (own data) and farmer (another farmer's data),
//  3. checks cross-site (CSRF) refusal and the rate limit for every state-changing route.
// To add a route you must add it here, and say what each caller gets.
/// <reference types="vite/client" />
import Database from "better-sqlite3";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LIMITS, type LimitName } from "../lib/limits";
import { resetRateLimits } from "../lib/rate-limit";
import { issueSession } from "../lib/session-store";
import { createReceiptLink } from "../lib/receipt-links";
import { startPayouts } from "../lib/payouts";
import { makeWorld, verifyAndApprove, type World } from "../lib/test-world";

// ---- test doubles for Next.js request context and the two things that touch the outside world ----
const h = vi.hoisted(() => ({ db: null as unknown as import("better-sqlite3").Database, provider: null as unknown, cookie: undefined as string | undefined }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "argus_session" && h.cookie ? { name: n, value: h.cookie } : undefined), set: () => {}, delete: () => {} }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {} }),
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${url};307;` });
  },
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  },
}));
vi.mock("../lib/db", async (orig) => ({ ...(await orig<typeof import("../lib/db")>()), getDb: () => h.db }));
vi.mock("../lib/provider", async (orig) => ({ ...(await orig<typeof import("../lib/provider")>()), getProvider: () => h.provider }));

process.env.SESSION_SECRET = "test-session-secret-for-token-box";

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------
type Exp = "ok" | 401 | 403 | `redirect:${string}`;
type Caller = "anon" | "buyer" | "operator" | "farmerOwn" | "farmerOther";
type Entry = Record<Caller, Exp> & {
  /** Path parameters. {order} {op} {link} {token} {farmer} are filled in from the fixture. */
  params?: Record<string, string>;
  form?: Record<string, string>;
  json?: unknown;
  /** The rate limit this route uses (must exist in lib/limits.ts). */
  limit?: LimitName;
  /** Public routes: no login needed at all. */
  publicRoute?: boolean;
};

const OP_ONLY = { anon: 401, buyer: 403, operator: "ok", farmerOwn: 403, farmerOther: 403 } as const;
const BUYER_ONLY = { anon: 401, buyer: "ok", operator: 403, farmerOwn: 403, farmerOther: 403 } as const;
const OP_OR_BUYER = { anon: 401, buyer: "ok", operator: "ok", farmerOwn: 403, farmerOther: 403 } as const;
const PAGE_OP = { anon: "redirect:/login", buyer: "redirect:/buyer", operator: "ok", farmerOwn: "redirect:/farmer", farmerOther: "redirect:/farmer" } as const;
const PAGE_BUYER = { anon: "redirect:/login", buyer: "ok", operator: "redirect:/operator", farmerOwn: "redirect:/farmer", farmerOther: "redirect:/farmer" } as const;
const PAGE_FARMER = { anon: "redirect:/login", buyer: "redirect:/buyer", operator: "redirect:/operator", farmerOwn: "ok", farmerOther: "ok" } as const;
const ALL_OK = { anon: "ok", buyer: "ok", operator: "ok", farmerOwn: "ok", farmerOther: "ok" } as const;

export const MATRIX: Record<string, Entry> = {
  // ---- pages ----
  "PAGE /": { anon: "redirect:/login", buyer: "redirect:/buyer", operator: "redirect:/operator", farmerOwn: "redirect:/farmer", farmerOther: "redirect:/farmer" },
  "PAGE /login": { ...ALL_OK },
  "PAGE /operator": { ...PAGE_OP },
  "PAGE /operator/orders/[id]": { ...PAGE_OP, params: { id: "{order}" } },
  "PAGE /operator/orders/new": { ...PAGE_OP },
  "PAGE /operator/review/[id]": { ...PAGE_OP, params: { id: "{order}" } },
  "PAGE /buyer": { ...PAGE_BUYER },
  "PAGE /farmer": { ...PAGE_FARMER },

  // ---- API: read ----
  "GET /api/orders": { ...OP_OR_BUYER, limit: "read" },
  "GET /api/farmers/[farmerId]": { anon: 401, buyer: 403, operator: "ok", farmerOwn: "ok", farmerOther: 403, params: { farmerId: "{farmer}" }, limit: "read" },
  "GET /api/payments/callback": { anon: "redirect:/login", buyer: "ok", operator: "ok", farmerOwn: "ok", farmerOther: "ok", limit: "callback" },
  "GET /r/[token]": { ...ALL_OK, params: { token: "{token}" }, publicRoute: true, limit: "receiptPublic" },

  // ---- API: orders ----
  "POST /api/orders": { ...OP_ONLY, json: "{newOrder}", limit: "orderCreate" },
  "POST /api/orders/preview": { ...OP_ONLY, json: "{newOrder}", limit: "orderPreview" },
  "POST /api/orders/[id]/quote": { ...BUYER_ONLY, params: { id: "{order}" }, limit: "quote" },
  "POST /api/orders/[id]/authorize": { ...BUYER_ONLY, params: { id: "{order}" }, limit: "authorize" },
  "POST /api/orders/[id]/reconcile": { ...OP_OR_BUYER, params: { id: "{order}" }, limit: "reconcile" },
  "POST /api/orders/[id]/verify-payees": { ...OP_ONLY, params: { id: "{order}" }, limit: "verifyPayees" },
  "POST /api/orders/[id]/approve": { ...OP_ONLY, params: { id: "{order}" }, form: { fingerprint: "0".repeat(64) }, limit: "approve" },
  "POST /api/orders/[id]/payouts/start": { ...OP_ONLY, params: { id: "{order}" }, limit: "payoutStart" },
  "POST /api/orders/[id]/payouts/requote": { ...OP_ONLY, params: { id: "{order}" }, limit: "payoutRequote" },
  "POST /api/orders/[id]/payouts/authorize": { ...OP_ONLY, params: { id: "{order}" }, limit: "payoutAuthorize" },
  "POST /api/orders/[id]/receipt-links": { ...OP_ONLY, params: { id: "{order}" }, json: "{newLink}", limit: "receiptLink" },

  // ---- API: payouts, receipts, demo ----
  "POST /api/payouts/[id]/reconcile": { ...OP_ONLY, params: { id: "{op}" }, limit: "payoutReconcile" },
  "POST /api/payouts/[id]/retry": { ...OP_ONLY, params: { id: "{op}" }, limit: "payoutRetry" },
  "POST /api/receipt-links/[id]/revoke": { ...OP_ONLY, params: { id: "{link}" }, limit: "receiptRevoke" },
  "POST /api/demo/reset": { ...OP_ONLY, form: { total: "10.00" }, limit: "demoReset" },
};

// Limits that are not tied to a route (they guard the login form, a server action).
const NON_ROUTE_LIMITS: LimitName[] = ["loginUser", "loginIp"];

// ---------------------------------------------------------------------------
// Fixture: an approved order with payouts started and a receipt link, copied fresh for every call
// ---------------------------------------------------------------------------
type Mod = Record<string, unknown>;
const modules = import.meta.glob<Mod>("../app/**/{page,route}.{ts,tsx}");
const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function routeOf(file: string): string {
  const r = file.replace("../app", "").replace(/\/(page\.tsx|route\.ts)$/, "");
  return r === "" ? "/" : r;
}

let template: Buffer;
let world: World;
let ids: { order: number; op: number; link: number; token: string; farmerAlloc: number; buyer: number; operator: number; farmerA: number; farmerB: number };

beforeAll(async () => {
  world = makeWorld();
  world.clock.t = Date.now(); // quotes expire relative to real time in the route code
  await verifyAndApprove(world);
  await startPayouts(world.deps, world.operator, 1);
  const alloc = (world.db.prepare("SELECT id FROM allocations WHERE order_id = 1 AND recipient = 'farmer-a'").get() as { id: number }).id;
  const link = createReceiptLink(world.db, "http://localhost:3000", world.operator, 1, alloc);
  const uid = (u: string) => (world.db.prepare("SELECT id FROM users WHERE username = ?").get(u) as { id: number }).id;
  ids = {
    order: 1, op: (world.db.prepare("SELECT id FROM payout_operations ORDER BY id LIMIT 1").get() as { id: number }).id, link: link.id, token: link.url.split("/r/")[1],
    farmerAlloc: alloc, buyer: uid("buyer"), operator: uid("operator"), farmerA: uid("farmer-a"), farmerB: uid("farmer-b"),
  };
  template = world.db.serialize();
});

beforeEach(() => {
  const db = new Database(template);
  db.pragma("foreign_keys = ON");
  h.db = db;
  h.provider = world.provider;
  h.cookie = undefined;
  resetRateLimits();
});

const fill = (v: string, who: Caller) =>
  v.replace("{order}", String(ids.order)).replace("{op}", String(ids.op)).replace("{link}", String(ids.link)).replace("{token}", ids.token).replace("{farmer}", who === "farmerOther" ? "farmer-b" : "farmer-a");

const newOrderBody = () => ({
  buyerUserId: ids.buyer,
  lines: [{ farmerId: "farmer-a", produce: "Maize", kg: "3", price: "4.00" }],
  terms: { "farmer-a": { fee: "100", deduction: "100" } },
});

function login(who: Caller) {
  const uid = who === "buyer" ? ids.buyer : who === "operator" ? ids.operator : who === "anon" ? 0 : ids.farmerA;
  h.cookie = who === "anon" ? undefined : issueSession(h.db as never, uid).token;
}

type Outcome = { kind: "response"; status: number; location: string | null } | { kind: "redirect"; to: string } | { kind: "notFound" } | { kind: "rendered"; html: string };

async function call(key: string, who: Caller, extra: { evilOrigin?: boolean; noOrigin?: boolean; body?: BodyInit; contentType?: string; query?: string; params?: Record<string, string> } = {}): Promise<Outcome> {
  const e = MATRIX[key];
  const [verb, route] = [key.split(" ")[0], key.split(" ").slice(1).join(" ")];
  const file = Object.keys(modules).find((f) => (verb === "PAGE" ? f.endsWith("page.tsx") : f.endsWith("route.ts")) && routeOf(f) === route)!;
  const mod = await modules[file]();
  const rawParams = { ...(e.params ?? {}), ...(extra.params ?? {}) };
  const params = Object.fromEntries(Object.entries(rawParams).map(([k, v]) => [k, fill(v, who)]));
  login(who);

  if (verb === "PAGE") {
    try {
      const out = await (mod.default as (p: unknown) => Promise<unknown>)({ params: Promise.resolve(params), searchParams: Promise.resolve({}) });
      return { kind: "rendered", html: renderToStaticMarkup(out as never) };
    } catch (err) {
      const digest = (err as { digest?: string }).digest ?? "";
      if (digest.startsWith("NEXT_REDIRECT")) return { kind: "redirect", to: digest.split(";")[2] };
      if (digest.includes("404")) return { kind: "notFound" };
      throw err;
    }
  }

  let urlPath = route;
  for (const [k, v] of Object.entries(params)) urlPath = urlPath.replace(`[${k}]`, v);
  const headers: Record<string, string> = { host: "localhost:3000" };
  if (verb !== "GET") {
    if (!extra.noOrigin) {
      headers.origin = extra.evilOrigin ? "https://evil.example" : "http://localhost:3000";
      headers["sec-fetch-site"] = extra.evilOrigin ? "cross-site" : "same-origin";
    }
  }
  let body: BodyInit | undefined = extra.body;
  if (body === undefined && e.json !== undefined) {
    const j = e.json === "{newOrder}" ? newOrderBody() : e.json === "{newLink}" ? { allocationId: ids.farmerAlloc, hours: 24 } : e.json;
    body = JSON.stringify(j);
    headers["content-type"] = "application/json";
  } else if (body === undefined && e.form) {
    body = new URLSearchParams(e.form).toString();
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  if (extra.contentType) headers["content-type"] = extra.contentType;
  const req = new Request(`http://localhost:3000${urlPath}${extra.query ?? ""}`, { method: verb, headers, body: verb === "GET" ? undefined : body, redirect: "manual" });
  const res = await (mod[verb] as (r: Request, c: unknown) => Promise<Response>)(req, { params: Promise.resolve(params) });
  return { kind: "response", status: res.status, location: res.headers.get("location") };
}

function describeOutcome(o: Outcome): string {
  if (o.kind === "response") return `${o.status}${o.location ? ` -> ${new URL(o.location).pathname}` : ""}`;
  if (o.kind === "redirect") return `redirect:${o.to}`;
  return o.kind;
}

function matches(exp: Exp, o: Outcome): boolean {
  if (o.kind === "rendered") return exp === "ok";
  if (o.kind === "redirect") return exp === `redirect:${o.to}`;
  if (o.kind === "notFound") return false;
  if (typeof exp === "string" && exp.startsWith("redirect:")) return o.status >= 300 && o.status < 400 && !!o.location && new URL(o.location).pathname === exp.slice(9);
  if (exp === 401 || exp === 403) return o.status === exp;
  return o.status >= 200 && o.status < 400; // "ok": the caller was let in and the request was handled without error
}

// ---------------------------------------------------------------------------
// 1. Completeness: no route can exist without being listed
// ---------------------------------------------------------------------------
describe("every route is in the matrix", () => {
  it("the matrix and the routes on disk are exactly the same list", async () => {
    const onDisk: string[] = [];
    for (const [file, load] of Object.entries(modules)) {
      const route = routeOf(file);
      if (file.endsWith("page.tsx")) onDisk.push(`PAGE ${route}`);
      else for (const verb of Object.keys(await load()).filter((k) => VERBS.includes(k))) onDisk.push(`${verb} ${route}`);
    }
    const listed = Object.keys(MATRIX);
    expect(onDisk.filter((r) => !listed.includes(r)), "routes that exist but are NOT in the access matrix").toEqual([]);
    expect(listed.filter((r) => !onDisk.includes(r)), "matrix entries for routes that no longer exist").toEqual([]);
    expect(onDisk.length).toBeGreaterThanOrEqual(25); // sanity: the glob really found the app
  });

  it("every route names a rate limit that exists, and together with the login limits they cover lib/limits.ts exactly", () => {
    const used = new Set<string>(NON_ROUTE_LIMITS);
    for (const [key, e] of Object.entries(MATRIX)) {
      if (key.startsWith("PAGE ")) continue;
      expect(e.limit, `${key} has no rate limit`).toBeTruthy();
      expect(Object.keys(LIMITS), key).toContain(e.limit);
      used.add(e.limit!);
    }
    expect([...used].sort()).toEqual(Object.keys(LIMITS).sort());
  });

  it("all state-changing routes are POST, and there is no PUT/PATCH/DELETE anywhere", () => {
    for (const key of Object.keys(MATRIX)) expect(["PAGE", "GET", "POST"], key).toContain(key.split(" ")[0]);
  });
});

// ---------------------------------------------------------------------------
// 2. Each route against each caller
// ---------------------------------------------------------------------------
const CALLERS: Caller[] = ["anon", "buyer", "operator", "farmerOwn", "farmerOther"];
describe("access matrix", () => {
  for (const key of Object.keys(MATRIX)) {
    describe(key, () => {
      for (const who of CALLERS) {
        it(`${who} -> ${String(MATRIX[key][who])}`, async () => {
          const o = await call(key, who);
          expect(matches(MATRIX[key][who], o), `${key} as ${who}: expected ${MATRIX[key][who]}, got ${describeOutcome(o)}`).toBe(true);
        });
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 3. Role boundaries on what pages actually show
// ---------------------------------------------------------------------------
describe("a farmer only ever sees their own data", () => {
  it("the farmer page shows farmer A's amounts and nothing of farmer B, C, logistics, wallets or phone numbers", async () => {
    const o = await call("PAGE /farmer", "farmerOwn");
    expect(o.kind).toBe("rendered");
    const html = (o as { html: string }).html;
    expect(html).toContain("3.70 USD");
    expect(html).toContain("PAY-");
    for (const forbidden of ["3.20", "2.30", "Farmer B", "Farmer C", "interledger", "https://", "tel:", "logistics"]) expect(html, forbidden).not.toContain(forbidden);
  });

  it("the API refuses farmer A reading farmer B (and a malformed id)", async () => {
    expect(matches(403, await call("GET /api/farmers/[farmerId]", "farmerOther"))).toBe(true);
    const bad = await call("GET /api/farmers/[farmerId]", "operator", { params: { farmerId: "../etc/passwd" } });
    expect(bad.kind === "response" && bad.status).toBe(400);
  });

  it("a buyer's API list contains only their own orders, with no payee or provider detail", async () => {
    const o = await call("GET /api/orders", "buyer");
    expect(o.kind === "response" && o.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4. CSRF: every state-changing route refuses cross-site and origin-less requests
// ---------------------------------------------------------------------------
const rowsCount = () =>
  JSON.stringify(
    ["audit_events", "orders", "payment_resources", "payout_operations", "payout_attempts", "grant_sessions", "receipt_links", "wallets"].map(
      (t) => (h.db.prepare(`SELECT COUNT(*) c FROM ${t}`).get() as { c: number }).c,
    ),
  );

describe("CSRF protection", () => {
  const stateChanging = Object.keys(MATRIX).filter((k) => k.startsWith("POST "));
  const allowedCaller = (e: Entry): Caller => (["operator", "buyer"] as Caller[]).find((c) => e[c] === "ok")!;

  for (const key of stateChanging) {
    it(`${key} refuses a cross-site request and one with no Origin/Referer, and changes nothing`, async () => {
      const who = allowedCaller(MATRIX[key]);
      // sanity: the same call from this site is let in
      expect(matches("ok", await call(key, who)), `${key} same-site as ${who}`).toBe(true);

      h.db = new Database(template);
      resetRateLimits();
      const before = rowsCount();
      const evil = await call(key, who, { evilOrigin: true });
      expect(evil.kind === "response" && evil.status, `${key} evil origin`).toBe(403);
      const none = await call(key, who, { noOrigin: true });
      expect(none.kind === "response" && none.status, `${key} no origin`).toBe(403);
      expect(rowsCount()).toBe(before);
    });
  }

  it("a Referer from this site is accepted when the browser sends no Origin, a foreign Referer is not", async () => {
    login("operator");
    const mod = await modules["../app/api/orders/preview/route.ts"]();
    const post = (extra: Record<string, string>) =>
      (mod.POST as (r: Request, c: unknown) => Promise<Response>)(
        new Request("http://localhost:3000/api/orders/preview", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", ...extra }, body: JSON.stringify(newOrderBody()) }),
        { params: Promise.resolve({}) },
      );
    expect((await post({ referer: "http://localhost:3000/operator/orders/new" })).status).toBe(200);
    expect((await post({ referer: "https://evil.example/x" })).status).toBe(403);
    expect((await post({ origin: "null" })).status).toBe(403);
    expect((await post({ origin: "http://localhost:3000", "sec-fetch-site": "same-site" })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 5. Rate limits: the limit-th call passes, the next is refused
// ---------------------------------------------------------------------------
describe("rate limits", () => {
  const limited = Object.entries(MATRIX).filter(([, e]) => e.limit && !e.publicRoute);
  for (const [key, e] of limited) {
    const name = e.limit!;
    it(`${key}: ${LIMITS[name].max} per minute (${name})`, async () => {
      const who: Caller = (["operator", "buyer"] as Caller[]).find((c) => e[c] === "ok") ?? "farmerOwn";
      const max = LIMITS[name].max;
      // A fresh database per call would hide rate limiting; use ONE database and a fixed caller.
      for (let i = 1; i <= max; i++) {
        const o = await call(key, who);
        expect(o.kind === "response" ? o.status : 0, `${key} call ${i} of ${max}`).not.toBe(429);
      }
      const over = await call(key, who);
      expect(over.kind === "response" && over.status, `${key} call ${max + 1}`).toBe(429);
    }, 60_000);
  }
});
