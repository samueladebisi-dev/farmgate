// After running the main flows with the mocked provider, no secret may appear in the audit log, in anything the app
// printed, or in plain text in the database. Also: the app code contains no logging statements at all.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { approveOrder, getReview } from "../lib/approval";
import { SECRET_CONTINUE, SECRET_TOKEN } from "../lib/mock-provider";
import { authenticate } from "../lib/login";
import { open } from "../lib/secretbox";
import { verifyPayees } from "../lib/payees";
import { handleCallback, quoteOrder, startAuthorization } from "../lib/payments";
import { authorizePayouts, handlePayoutCallback, startPayouts } from "../lib/payouts";
import { createReceiptLink } from "../lib/receipt-links";
import { issueSession } from "../lib/session-store";
import { approvedQuery, declinedQuery, makeWorld, type World } from "../lib/test-world";

const PASSWORDS = { buyer: "pw-buyer-ZZ1", operator: "pw-operator-ZZ2", farmerA: "pw-a-ZZ3", farmerB: "pw-b-ZZ4", farmerC: "pw-c-ZZ5" };
process.env.SESSION_SECRET = "test-session-secret-for-token-box";

let w: World;
const printed: string[] = [];
let receiptToken = "";
let sessionToken = "";
const grantNonces: string[] = [];
const interactRefs = new Set<string>();

beforeAll(async () => {
  // Capture everything the app might print.
  for (const m of ["log", "info", "warn", "error", "debug"] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void printed.push(a.map(String).join(" ")));
  vi.spyOn(process.stdout, "write").mockImplementation(((s: unknown) => (printed.push(String(s)), true)) as never);
  vi.spyOn(process.stderr, "write").mockImplementation(((s: unknown) => (printed.push(String(s)), true)) as never);

  w = makeWorld();
  // makeWorld seeds with its own passwords; re-hash with ours so we can search for them.
  const { hashPassword } = await import("../lib/password");
  for (const [u, p] of [["buyer", PASSWORDS.buyer], ["operator", PASSWORDS.operator], ["farmer-a", PASSWORDS.farmerA], ["farmer-b", PASSWORDS.farmerB], ["farmer-c", PASSWORDS.farmerC]])
    w.db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(hashPassword(p), u);
  const grab = () => {
    const g = w.provider.lastGrant!;
    grantNonces.push(g.nonce, g.serverNonce);
    return g;
  };

  // login: good, bad, rate limited
  authenticate(w.db, { username: "buyer", password: "WRONG-GUESS-123", ip: "9.9.9.9" });
  authenticate(w.db, { username: "buyer", password: PASSWORDS.buyer, ip: "9.9.9.9" });
  sessionToken = issueSession(w.db, w.buyer.id).token;

  // buyer payment, with a declined consent first
  await quoteOrder(w.deps, w.buyer, 1);
  await startAuthorization(w.deps, w.buyer, 1);
  await handleCallback(w.deps, w.buyer, declinedQuery(grab()));
  await startAuthorization(w.deps, w.buyer, 1);
  interactRefs.add("interact-ref-9");
  await handleCallback(w.deps, w.buyer, approvedQuery(grab()));

  // cooperative side
  await verifyPayees(w.deps, w.operator, 1);
  await approveOrder(w.deps, w.operator, 1, getReview(w.deps, w.operator, 1).fingerprint);
  await startPayouts(w.deps, w.operator, 1);
  await authorizePayouts(w.deps, w.operator, 1);
  await handlePayoutCallback(w.deps, w.operator, declinedQuery(grab()));
  await authorizePayouts(w.deps, w.operator, 1);
  await handlePayoutCallback(w.deps, w.operator, approvedQuery(grab()));

  // receipts
  const alloc = (w.db.prepare("SELECT id FROM allocations WHERE recipient = 'farmer-a'").get() as { id: number }).id;
  receiptToken = createReceiptLink(w.db, "http://localhost:3000", w.operator, 1, alloc).url.split("/r/")[1];
});

afterAll(() => vi.restoreAllMocks());

/** Everything that must never show up in logs or the audit trail. */
const secrets = () => [
  SECRET_TOKEN, SECRET_CONTINUE, "SECRET-ACCESS-TOKEN", "SECRET-CONTINUE-TOKEN", ...Object.values(PASSWORDS), "WRONG-GUESS-123",
  process.env.SESSION_SECRET!, receiptToken, sessionToken, "interact-ref-9", ...grantNonces,
];
const keyMaterial = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /MC4CAQAwBQYDK2VwBCIE/, /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/];

describe("secrets never reach the audit log or the output", () => {
  it("the flows really ran (so the scan means something)", () => {
    expect((w.db.prepare("SELECT status FROM orders WHERE id = 1").get() as { status: string }).status).toBe("COMPLETED");
    const actions = (w.db.prepare("SELECT action FROM audit_events").all() as { action: string }[]).map((r) => r.action);
    for (const a of ["QUOTE_CREATED", "CONSENT_STARTED", "CONSENT_REJECTED", "GRANT_VERIFIED", "OUTGOING_CREATED", "SPLIT_APPROVED", "PAYOUT_SUBMIT_SUMMARY", "RECEIPT_LINK_CREATED", "login.failed"]) expect(actions, a).toContain(a);
    expect(actions.filter((a) => a === "CONSENT_REJECTED")).toHaveLength(2);
    expect(grantNonces.length).toBeGreaterThanOrEqual(6);
  });

  it("audit_events contain none of: provider tokens, passwords, session secret, receipt tokens, grant nonces, interaction refs, key material", () => {
    const audit = JSON.stringify(w.db.prepare("SELECT * FROM audit_events").all());
    for (const s of secrets()) expect(audit, `audit contains ${s.slice(0, 12)}...`).not.toContain(s);
    for (const re of keyMaterial) expect(audit).not.toMatch(re);
    // no long random-looking token inside any audit metadata value
    for (const r of w.db.prepare("SELECT metadata FROM audit_events").all() as { metadata: string }[]) expect(r.metadata).not.toMatch(/[A-Za-z0-9_-]{40,}/);
  });

  it("nothing was printed by the app (and nothing printed contains a secret)", () => {
    const out = printed.join("\n");
    for (const s of secrets()) expect(out).not.toContain(s);
    for (const re of keyMaterial) expect(out).not.toMatch(re);
  });

  it("the database holds no provider token, password, session secret or key in plain text; tokens exist only encrypted", () => {
    const tables = (w.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((t) => t.name);
    const mustNotAppear = [SECRET_TOKEN, SECRET_CONTINUE, "SECRET-ACCESS-TOKEN", "SECRET-CONTINUE-TOKEN", ...Object.values(PASSWORDS), process.env.SESSION_SECRET!, receiptToken, sessionToken];
    for (const t of tables) {
      const dump = JSON.stringify(w.db.prepare(`SELECT * FROM ${t}`).all());
      for (const s of mustNotAppear) expect(dump, `${t} contains plain ${s.slice(0, 10)}...`).not.toContain(s);
      for (const re of keyMaterial) expect(dump, t).not.toMatch(re);
    }
    // the encrypted columns decrypt back to the real tokens, so they are protected, not missing
    const enc = w.db.prepare("SELECT continue_token_enc c, access_token_enc a FROM grant_sessions WHERE access_token_enc IS NOT NULL").get() as { c: string; a: string };
    expect(open(enc.a)).toContain("SECRET-ACCESS-TOKEN");
    expect(open(enc.c)).toContain("SECRET-CONTINUE-TOKEN");
    expect(enc.a).not.toContain("SECRET");
  });

  it("the real private key file (if present) appears nowhere either", () => {
    const keyFile = path.join(process.cwd(), "private.key");
    if (!fs.existsSync(keyFile)) return;
    const body = fs.readFileSync(keyFile, "utf8").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
    if (body.length < 20) return;
    const everything = JSON.stringify(w.db.prepare("SELECT * FROM audit_events").all()) + printed.join("\n");
    expect(everything).not.toContain(body);
  });
});

describe("the app code does not log", () => {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

  it("no console or debugger statements in app/ or lib/ (scripts and tests may print)", () => {
    const files = [...walk("app"), ...walk("lib")].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f));
    expect(files.length).toBeGreaterThan(30);
    const offenders = files.filter((f) => /\bconsole\.(log|info|warn|error|debug|trace)\b|\bdebugger\b/.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("no source file reads or prints the private key", () => {
    const files = [...walk("app"), ...walk("lib")].filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.ts$/.test(f));
    const offenders = files.filter((f) => /readFileSync\([^)]*private/i.test(fs.readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
