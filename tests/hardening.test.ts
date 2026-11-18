// Hardening: login brute-force limits, real logout, cookie flags, security headers, and strict input validation on routes.
import Database from "better-sqlite3";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, openDb, type Db } from "../lib/db";
import { authenticate } from "../lib/login";
import { LIMITS } from "../lib/limits";
import { resetRateLimits } from "../lib/rate-limit";
import { checkCallbackQuery } from "../lib/callback-params";
import { cookieSecure, readSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "../lib/session";
import { activeSession, issueSession, revokeSession } from "../lib/session-store";
import { seedDatabase } from "../lib/seed";
import nextConfig, { contentSecurityPolicy } from "../next.config";

const h = vi.hoisted(() => ({
  db: null as unknown as import("better-sqlite3").Database,
  cookie: undefined as string | undefined,
  sets: [] as { name: string; value: string; options: Record<string, unknown> }[],
  deletes: [] as string[],
}));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (n === "argus_session" && h.cookie ? { name: n, value: h.cookie } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      h.sets.push({ name, value, options });
      h.cookie = value;
    },
    delete: (n: string) => {
      h.deletes.push(n);
      h.cookie = undefined;
    },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }),
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

process.env.SESSION_SECRET = "test-session-secret-for-token-box";
const PASSWORDS = { buyer: "pw-buyer-1", operator: "pw-operator-1", farmerA: "pw-a-1", farmerB: "pw-b-1", farmerC: "pw-c-1" };

let template: Buffer;
beforeAll(() => {
  const db = openDb(":memory:");
  applyMigrations(db);
  seedDatabase(db, { orderTotalMinor: 1000, passwords: PASSWORDS });
  template = db.serialize();
});
let db: Db;
beforeEach(() => {
  db = new Database(template);
  db.pragma("foreign_keys = ON");
  h.db = db;
  h.cookie = undefined;
  h.sets = [];
  h.deletes = [];
  resetRateLimits();
});
const uid = (u: string) => (db.prepare("SELECT id FROM users WHERE username = ?").get(u) as { id: number }).id;

// ---------------------------------------------------------------------------
describe("login: brute-force protection", () => {
  it("blocks after the per-username limit, even for the correct password, and tells nothing about which part was wrong", () => {
    const max = LIMITS.loginUser.max;
    for (let i = 0; i < max; i++) expect(authenticate(db, { username: "buyer", password: "wrong", ip: "1.1.1.1" })).toEqual({ ok: false, reason: "INVALID" });
    expect(authenticate(db, { username: "buyer", password: PASSWORDS.buyer, ip: "1.1.1.1" })).toEqual({ ok: false, reason: "RATE_LIMITED" });
    expect(authenticate(db, { username: "buyer", password: PASSWORDS.buyer, ip: "9.9.9.9" })).toEqual({ ok: false, reason: "RATE_LIMITED" }); // another address does not help
    expect(authenticate(db, { username: "operator", password: PASSWORDS.operator, ip: "1.1.1.1" }).ok).toBe(true); // other users unaffected
    // unknown user and wrong password look identical
    expect(authenticate(db, { username: "nobody", password: "x", ip: "2.2.2.2" })).toEqual({ ok: false, reason: "INVALID" });
  });

  it("the window passes and login works again", () => {
    const t0 = Date.now();
    for (let i = 0; i < LIMITS.loginUser.max + 1; i++) authenticate(db, { username: "buyer", password: "wrong", ip: "1.1.1.1" }, t0);
    expect(authenticate(db, { username: "buyer", password: PASSWORDS.buyer, ip: "1.1.1.1" }, t0 + 1_000).ok).toBe(false);
    expect(authenticate(db, { username: "buyer", password: PASSWORDS.buyer, ip: "1.1.1.1" }, t0 + 61_000).ok).toBe(true);
  });

  it("limits one address trying many usernames", () => {
    for (let i = 0; i < LIMITS.loginIp.max; i++) authenticate(db, { username: `guess${i}`, password: "x", ip: "6.6.6.6" });
    expect(authenticate(db, { username: "operator", password: PASSWORDS.operator, ip: "6.6.6.6" })).toEqual({ ok: false, reason: "RATE_LIMITED" });
  });

  it("rejects non-string input and never audits a password", () => {
    expect(authenticate(db, { username: { $ne: 1 }, password: ["x"], ip: "3.3.3.3" }).ok).toBe(false);
    authenticate(db, { username: "buyer", password: "SUPER-SECRET-GUESS", ip: "3.3.3.3" });
    expect(JSON.stringify(db.prepare("SELECT * FROM audit_events").all())).not.toContain("SUPER-SECRET-GUESS");
    expect((db.prepare("SELECT action FROM audit_events WHERE action = 'login.failed'").all() as unknown[]).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
describe("sessions and cookies", () => {
  it("a session is valid only while the server says so", () => {
    const { token, sid } = issueSession(db, uid("buyer"));
    expect(activeSession(db, token)?.uid).toBe(uid("buyer"));
    revokeSession(db, sid);
    expect(activeSession(db, token)).toBeNull(); // the SAME cookie no longer works
  });

  it("expired, tampered and unknown sessions are refused", () => {
    const t0 = Date.now();
    const { token } = issueSession(db, uid("buyer"), t0);
    expect(activeSession(db, token, t0 + 1000)).not.toBeNull();
    expect(activeSession(db, token, t0 + (SESSION_TTL_SECONDS + 5) * 1000)).toBeNull();
    expect(activeSession(db, token.slice(0, -2) + "xx")).toBeNull();
    expect(activeSession(db, undefined)).toBeNull();
    db.prepare("DELETE FROM sessions").run();
    expect(activeSession(db, token, t0 + 1000)).toBeNull(); // signed but no server record
  });

  it("a cookie made for one user cannot be used for another", () => {
    const { token, sid } = issueSession(db, uid("buyer"));
    db.prepare("UPDATE sessions SET user_id = ? WHERE sid = ?").run(uid("operator"), sid);
    expect(activeSession(db, token)).toBeNull();
  });

  it("Secure is on everywhere except localhost", () => {
    expect(cookieSecure("http://localhost:3000")).toBe(false);
    expect(cookieSecure("http://127.0.0.1:3000")).toBe(false);
    expect(cookieSecure(undefined)).toBe(false);
    expect(cookieSecure("https://argus.example.org")).toBe(true);
    expect(cookieSecure("http://192.168.1.20:3000")).toBe(true);
    expect(cookieSecure("http://my-laptop.local:3000")).toBe(true);
    expect(cookieSecure("not a url")).toBe(true);
  });

  it("login sets an HttpOnly, SameSite cookie with the right Secure flag, and creates a server session", async () => {
    const { loginAction } = await import("../app/actions");
    const form = new FormData();
    form.set("username", "farmer-a");
    form.set("password", PASSWORDS.farmerA);
    for (const [base, secure] of [["http://localhost:3000", false], ["https://argus.example.org", true]] as const) {
      h.sets = [];
      process.env.APP_BASE_URL = base;
      resetRateLimits();
      await expect(loginAction(undefined, form)).rejects.toMatchObject({ digest: expect.stringContaining("/farmer") });
      const c = h.sets.find((s) => s.name === SESSION_COOKIE)!;
      expect(c.options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", secure });
      expect(Number(c.options.maxAge)).toBe(SESSION_TTL_SECONDS);
      expect(activeSession(db, c.value)?.uid).toBe(uid("farmer-a"));
    }
    delete process.env.APP_BASE_URL;
  });

  it("wrong password gives the generic message and no cookie; too many tries gives the wait message", async () => {
    const { loginAction } = await import("../app/actions");
    const bad = new FormData();
    bad.set("username", "buyer");
    bad.set("password", "nope");
    expect(await loginAction(undefined, bad)).toEqual({ error: "Wrong username or password" });
    expect(h.sets).toHaveLength(0);
    for (let i = 0; i < LIMITS.loginUser.max; i++) await loginAction(undefined, bad);
    expect(await loginAction(undefined, bad)).toEqual({ error: "Too many attempts. Wait a minute and try again." });
  });

  it("logout REALLY ends the session: the old cookie is dead on the server", async () => {
    const { loginAction, logoutAction } = await import("../app/actions");
    const form = new FormData();
    form.set("username", "operator");
    form.set("password", PASSWORDS.operator);
    await expect(loginAction(undefined, form)).rejects.toBeTruthy();
    const stolen = h.cookie!; // someone copied the cookie
    expect(activeSession(db, stolen)).not.toBeNull();
    await expect(logoutAction()).rejects.toMatchObject({ digest: expect.stringContaining("/login") });
    expect(h.deletes).toContain(SESSION_COOKIE);
    expect(activeSession(db, stolen)).toBeNull();
    expect(readSessionToken(stolen)).not.toBeNull(); // the signature alone is still fine: only the server record makes the difference
    // and a route refuses it
    h.cookie = stolen;
    const { GET } = await import("../app/api/orders/route");
    expect((await GET(new Request("http://localhost:3000/api/orders", { headers: { host: "localhost:3000" } }), {})).status).toBe(401);
    expect(JSON.stringify(db.prepare("SELECT action FROM audit_events").all())).toContain("logout");
  });
});

// ---------------------------------------------------------------------------
describe("security headers", () => {
  it("every page gets CSP, frame protection, nosniff, referrer and permissions policy", async () => {
    const rules = await nextConfig.headers!();
    const all = rules.find((r) => r.source === "/:path*")!;
    const get = (k: string) => all.headers.find((x) => x.key === k)?.value ?? "";
    expect(get("X-Frame-Options")).toBe("DENY");
    expect(get("X-Content-Type-Options")).toBe("nosniff");
    expect(get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(get("Permissions-Policy")).toMatch(/camera=\(\)/);
    const csp = get("Content-Security-Policy");
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"]) expect(csp).toContain(d);
    expect(csp).not.toMatch(/script-src[^;]*\*/);
    expect(nextConfig.poweredByHeader).toBe(false);
  });

  it("unsafe-eval is allowed only in development", () => {
    expect(contentSecurityPolicy(true)).not.toContain("unsafe-eval");
    expect(contentSecurityPolicy(false)).toContain("unsafe-eval");
    expect(contentSecurityPolicy(true)).not.toContain("ws:");
  });
});

// ---------------------------------------------------------------------------
// Strict input validation on routes
// ---------------------------------------------------------------------------
describe("input validation", () => {
  const same = { host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" };
  let session: string;
  beforeEach(() => {
    session = issueSession(db, uid("operator")).token;
    h.cookie = session;
  });
  const json = (body: unknown, extra: Record<string, string> = {}) => ({ method: "POST", headers: { ...same, "content-type": "application/json", ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const form = (fields: Record<string, string | undefined>) => ({ method: "POST", headers: { ...same, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(Object.entries(fields).filter((e): e is [string, string] => e[1] !== undefined)).toString() });
  const status = async (mod: Record<string, unknown>, verb: string, path: string, init: RequestInit, params: Record<string, string> = {}) =>
    (await (mod[verb] as (r: Request, c: unknown) => Promise<Response>)(new Request(`http://localhost:3000${path}`, init), { params: Promise.resolve(params) })).status;
  const validOrder = () => ({
    buyerUserId: uid("buyer"),
    lines: [{ farmerId: "farmer-a", produce: "Maize", kg: "3", price: "4.00" }],
    terms: { "farmer-a": { fee: "100", deduction: "100" } },
  });

  it("POST /api/orders and /preview: valid passes; unknown fields, wrong types, bad JSON, big bodies, query strings all 400", async () => {
    for (const path of ["/api/orders/preview", "/api/orders"]) {
      const mod = await import(path === "/api/orders" ? "../app/api/orders/route" : "../app/api/orders/preview/route");
      expect(await status(mod, "POST", path, json(validOrder())), `${path} valid`).toBe(path === "/api/orders" ? 200 : 200);
      const bad: [string, unknown][] = [
        ["unknown top-level field", { ...validOrder(), admin: true }],
        ["unknown line field", { ...validOrder(), lines: [{ ...validOrder().lines[0], discount: 1 }] }],
        ["unknown terms field", { ...validOrder(), terms: { "farmer-a": { fee: "1", deduction: "1", bonus: 1 } } }],
        ["buyerUserId as text", { ...validOrder(), buyerUserId: "1" }],
        ["buyerUserId as float", { ...validOrder(), buyerUserId: 1.5 }],
        ["lines not an array", { ...validOrder(), lines: "x" }],
        ["line not an object", { ...validOrder(), lines: ["x"] }],
        ["price as number", { ...validOrder(), lines: [{ ...validOrder().lines[0], price: 4 }] }],
        ["kg as object", { ...validOrder(), lines: [{ ...validOrder().lines[0], kg: {} }] }],
        ["too many lines", { ...validOrder(), lines: Array(21).fill(validOrder().lines[0]) }],
        ["a JSON array", [1, 2]],
        ["null", null],
      ];
      for (const [name, body] of bad) expect(await status(mod, "POST", path, json(body)), `${path}: ${name}`).toBe(400);
      expect(await status(mod, "POST", path, json("{not json")), `${path}: bad json`).toBe(400);
      expect(await status(mod, "POST", path, json("x".repeat(60_000))), `${path}: huge`).toBe(400);
      expect(await status(mod, "POST", path, form({ a: "b" })), `${path}: form instead of json`).toBe(400);
      expect(await status(mod, "POST", path + "?admin=1", json(validOrder())), `${path}: query`).toBe(400);
    }
  });

  it("GET routes refuse query strings and malformed ids", async () => {
    const orders = await import("../app/api/orders/route");
    expect(await status(orders, "GET", "/api/orders", { headers: same })).toBe(200);
    expect(await status(orders, "GET", "/api/orders?x=1", { headers: same })).toBe(400);
    const farmers = await import("../app/api/farmers/[farmerId]/route");
    expect(await status(farmers, "GET", "/api/farmers/farmer-a", { headers: same }, { farmerId: "farmer-a" })).toBe(200);
    for (const bad of ["farmer-A", "farmer-", "x", "farmer-a%00", "farmer-" + "a".repeat(40), "../x"])
      expect(await status(farmers, "GET", "/api/farmers/x", { headers: same }, { farmerId: bad }), bad).toBe(400);
  });

  it("path ids must be plain positive whole numbers", async () => {
    const mod = await import("../app/api/orders/[id]/verify-payees/route");
    for (const bad of ["abc", "0", "-1", "1.5", "01", "99999999999", "1;drop", ""]) {
      resetRateLimits(); // this route allows only a few calls a minute
      expect(await status(mod, "POST", "/api/orders/x/verify-payees", form({}), { id: bad }), bad).toBe(400);
    }
  });

  it("form routes accept only their own fields", async () => {
    const approve = await import("../app/api/orders/[id]/approve/route");
    const p = { id: "1" };
    expect(await status(approve, "POST", "/api/orders/1/approve", form({}), p)).toBe(400); // missing fingerprint
    expect(await status(approve, "POST", "/api/orders/1/approve", form({ fingerprint: "xyz" }), p)).toBe(400);
    expect(await status(approve, "POST", "/api/orders/1/approve", form({ fingerprint: "a".repeat(64), extra: "1" }), p)).toBe(400);
    const demo = await import("../app/api/demo/reset/route");
    for (const bad of [{ total: "abc" }, { total: "10.001" }, { total: "-10" }, { total: "10.00", x: "1" }, {}]) expect(await status(demo, "POST", "/api/demo/reset", form(bad)), JSON.stringify(bad)).toBe(400);
    const authorize = await import("../app/api/orders/[id]/payouts/authorize/route");
    expect(await status(authorize, "POST", "/api/orders/1/payouts/authorize", form({ operationId: "abc" }), p)).toBe(400);
    expect(await status(authorize, "POST", "/api/orders/1/payouts/authorize", form({ other: "1" }), p)).toBe(400);
    const quote = await import("../app/api/orders/[id]/quote/route");
    h.cookie = issueSession(db, uid("buyer")).token;
    expect(await status(quote, "POST", "/api/orders/1/quote", form({ amount: "1" }), p)).toBe(400); // routes with no fields refuse any field
  });

  it("receipt link body is strict", async () => {
    const mod = await import("../app/api/orders/[id]/receipt-links/route");
    const p = { id: "1" };
    const alloc = (db.prepare("SELECT id FROM allocations WHERE recipient = 'farmer-a'").get() as { id: number }).id;
    expect(await status(mod, "POST", "/api/orders/1/receipt-links", json({ allocationId: alloc, hours: 24 }), p)).toBe(200);
    for (const bad of [{ allocationId: "1" }, { allocationId: alloc, hours: 25 }, { allocationId: alloc, hours: 0 }, { allocationId: alloc, hours: 1.5 }, { allocationId: alloc, admin: 1 }, {}, { allocationId: -1 }])
      expect(await status(mod, "POST", "/api/orders/1/receipt-links", json(bad), p), JSON.stringify(bad)).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("callback query checks", () => {
  it("accepts the expected shape and notes unknown parameter names", () => {
    expect(checkCallbackQuery(new URLSearchParams("gs=0a1b2c3d-0000-4000-8000-000000000000&order=1&purpose=PAYOUT&hash=abcdefghijklmnopqrstuv&interact_ref=ref-1"))).toEqual({ ok: true, unknown: [] });
    expect(checkCallbackQuery(new URLSearchParams("result=grant_rejected&weird=1"))).toEqual({ ok: true, unknown: ["weird"] });
  });
  it.each([
    ["bad gs", "gs=not-a-uuid"], ["order text", "order=abc"], ["unknown purpose", "purpose=ADMIN"], ["hash with symbols", "hash=%3Cscript%3E"], ["huge interact_ref", `interact_ref=${"a".repeat(200)}`],
    ["duplicate param", "order=1&order=2"], ["result with caps", "result=GRANT"],
  ])("refuses %s", (_n, qs) => {
    expect(checkCallbackQuery(new URLSearchParams(qs)).ok).toBe(false);
  });

  it("a malformed callback is audited, not silently dropped", async () => {
    h.cookie = issueSession(db, uid("buyer")).token;
    const { GET } = await import("../app/api/payments/callback/route");
    const res = await GET(new Request("http://localhost:3000/api/payments/callback?hash=%3Cscript%3E", { headers: { host: "localhost:3000" } }));
    expect(res.status).toBe(303);
    const rows = db.prepare("SELECT metadata FROM audit_events WHERE action = 'GRANT_REJECTED'").all() as { metadata: string }[];
    expect(rows.map((r) => r.metadata).join()).toContain("BAD_PARAM_hash");
    await GET(new Request("http://localhost:3000/api/payments/callback?extra=1", { headers: { host: "localhost:3000" } }));
    expect(JSON.stringify(db.prepare("SELECT action FROM audit_events").all())).toContain("CALLBACK_EXTRA_PARAMS");
  });
});
