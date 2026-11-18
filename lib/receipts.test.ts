import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError, getFarmerRecord, NotFoundError } from "./access";
import { PAYOUT_STATES, STATE_WORDS } from "./payout-state";
import { authorizePayouts, handlePayoutCallback, startPayouts } from "./payouts";
import { resetRateLimits } from "./rate-limit";
import { loadReceipt, receiptFromAllocation, receiptText } from "./receipt";
import { escapeHtml, handleReceiptRequest, receiptHeaders } from "./receipt-html";
import { createReceiptLink, hashToken, listReceiptLinks, resolveReceiptLink, revokeReceiptLink } from "./receipt-links";
import { approvedQuery, makeWorld, verifyAndApprove, type World } from "./test-world";
import nextConfig from "../next.config";

let w: World;
beforeEach(() => {
  w = makeWorld();
  resetRateLimits();
});
const allocId = (recipient: string, order = 1) => (w.db.prepare("SELECT id FROM allocations WHERE order_id = ? AND recipient = ?").get(order, recipient) as { id: number }).id;
const mk = (recipient: string, hours?: number, now?: number) => createReceiptLink(w.db, "http://localhost:3000", w.operator, 1, allocId(recipient), hours, now);
const tokenOf = (url: string) => url.split("/r/")[1];
const farmer = (username: string) => {
  const u = w.db.prepare("SELECT id, role, name, linked_farmer_id FROM users WHERE username = ?").get(username) as { id: number; role: "farmer"; name: string; linked_farmer_id: string };
  return { id: u.id, role: u.role, name: u.name, linkedFarmerId: u.linked_farmer_id };
};

describe("SMS-length text receipt", () => {
  it("has the agreed shape", () => {
    expect(receiptText({ orderRef: "PO-0125", amountText: "3.70 USD", paid: true, statusWords: "Paid", reference: "PAY-041" })).toBe(
      "TEST PAYMENT\nOrder: PO-0125\nYou got: 3.70 USD\nStatus: Paid\nRef: PAY-041\nHelp: Ask your operator",
    );
  });

  it("is under 160 characters for EVERY state, even with long references and amounts, and is plain ASCII (no emoji)", () => {
    const words = [...PAYOUT_STATES.map((s) => STATE_WORDS[s].farmer), "Not started"];
    for (const paid of [true, false])
      for (const statusWords of words) {
        const t = receiptText({ orderRef: "PO-123456", amountText: "123456789012.00 USD", paid, statusWords, reference: "PAY-123456" });
        expect(t.length, `${statusWords} paid=${paid}`).toBeLessThan(160);
        expect(t).toMatch(/^[\x20-\x7E\n]+$/);
      }
  });

  it("is built from the real receipt of each state", async () => {
    const before = loadReceipt(w.db, allocId("farmer-a"))!;
    expect(before.text).toBe(`TEST PAYMENT\nOrder: PO-0124\nYou will get: 3.70 USD\nStatus: Not started\nRef: ${before.reference}\nHelp: Ask your operator`);
    await verifyAndApprove(w);
    await startPayouts(w.deps, w.operator, 1);
    await authorizePayouts(w.deps, w.operator, 1);
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(w.provider.lastGrant!));
    const after = loadReceipt(w.db, allocId("farmer-a"))!;
    expect(after.text).toBe(`TEST PAYMENT\nOrder: PO-0124\nYou got: 3.70 USD\nStatus: Paid\nRef: ${after.reference}\nHelp: Ask your operator`);
    expect(after.reference).toMatch(/^PAY-\d{3}$/);
  });

  it("the receipt has no wallet address, phone number, or any other recipient", () => {
    const r = loadReceipt(w.db, allocId("farmer-a"))!;
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/http|interledger|tel:|\+\d{6}/i);
    expect(text).not.toContain("3.20");
    expect(text).not.toContain("Farmer B");
    expect([r.grossText, r.feeText, r.deductionText, r.netText]).toEqual(["4.00 USD", "0.20 USD", "0.10 USD", "3.70 USD"]);
  });

  it("the cooperative's retained amount has no recipient receipt", () => {
    expect(loadReceipt(w.db, allocId("cooperative"))).toBeNull();
  });

  it("a farmer can read only their own record (cross-farmer access)", () => {
    expect(() => getFarmerRecord(w.db, farmer("farmer-a"), "farmer-b")).toThrow(ForbiddenError);
    const mine = getFarmerRecord(w.db, farmer("farmer-b"), "farmer-b")[0];
    const text = receiptFromAllocation({ ...mine.allocation!, orderRef: mine.orderRef }).text;
    expect(text).toContain("3.20 USD");
    expect(JSON.stringify(mine)).not.toContain("3.70");
  });
});

describe("receipt links", () => {
  it("only operators can create or revoke", () => {
    expect(() => createReceiptLink(w.db, "http://x", w.buyer, 1, allocId("farmer-a"))).toThrow(ForbiddenError);
    expect(() => createReceiptLink(w.db, "http://x", { id: 5, role: "farmer" }, 1, allocId("farmer-a"))).toThrow(ForbiddenError);
    const l = mk("farmer-a");
    expect(() => revokeReceiptLink(w.db, w.buyer, l.id)).toThrow(ForbiddenError);
    expect(() => listReceiptLinks(w.db, w.buyer, 1)).toThrow(ForbiddenError);
  });

  it("the token is long, random and unguessable, and only its hash is stored", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 300; i++) tokens.add(tokenOf(mk("farmer-a").url));
    expect(tokens.size).toBe(300);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits
    const l = mk("farmer-b");
    const token = tokenOf(l.url);
    expect(l.url).toBe(`http://localhost:3000/r/${token}`);
    const rows = JSON.stringify(w.db.prepare("SELECT * FROM receipt_links").all());
    expect(rows).not.toContain(token); // never stored in plain text
    expect(rows).toContain(hashToken(token));
    expect(hashToken(token)).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(w.db.prepare("SELECT * FROM audit_events").all())).not.toContain(token); // nor audited
    expect(JSON.stringify(listReceiptLinks(w.db, w.operator, 1))).not.toContain(token);
  });

  it("shows only the recipient the link was made for", () => {
    const a = tokenOf(mk("farmer-a").url);
    const b = tokenOf(mk("farmer-b").url);
    const ra = resolveReceiptLink(w.db, a);
    const rb = resolveReceiptLink(w.db, b);
    expect(ra.ok && ra.receipt.recipientName).toBe("Farmer A");
    expect(rb.ok && rb.receipt.recipientName).toBe("Farmer B");
    expect(JSON.stringify(ra)).not.toContain("3.20");
    expect(JSON.stringify(ra)).not.toContain("Farmer B");
    // a link cannot be edited to point elsewhere: any change to the token is simply unknown
    expect(resolveReceiptLink(w.db, a.slice(0, -1) + (a.endsWith("A") ? "B" : "A")).ok).toBe(false);
    expect(resolveReceiptLink(w.db, `${a}x`).ok).toBe(false);
    expect(resolveReceiptLink(w.db, "").ok).toBe(false);
    expect(resolveReceiptLink(w.db, "1").ok).toBe(false);
    expect(resolveReceiptLink(w.db, "A".repeat(43)).ok).toBe(false);
  });

  it("refuses a recipient that is not on the order, and the cooperative row", () => {
    expect(() => createReceiptLink(w.db, "http://x", w.operator, 1, 9999)).toThrow(NotFoundError);
    expect(() => createReceiptLink(w.db, "http://x", w.operator, 1, allocId("cooperative"))).toThrow(NotFoundError);
    expect(() => createReceiptLink(w.db, "http://x", w.operator, 2, allocId("farmer-a"))).toThrow(NotFoundError); // wrong order
  });

  it("expires on the server: at most 24 hours, even if more is asked for", () => {
    const t0 = Date.parse("2026-11-18T12:00:00Z");
    const long = mk("farmer-a", 500, t0);
    expect(Date.parse(long.expiresAt) - t0).toBe(24 * 3_600_000);
    expect(long.hours).toBe(24);
    const short = mk("farmer-b", 1, t0);
    expect(Date.parse(short.expiresAt) - t0).toBe(3_600_000);
    expect(mk("farmer-c", 0, t0).hours).toBe(1);
    expect(mk("farmer-c", Number.NaN, t0).hours).toBe(24);
    const tok = tokenOf(short.url);
    expect(resolveReceiptLink(w.db, tok, t0 + 3_599_000).ok).toBe(true);
    expect(resolveReceiptLink(w.db, tok, t0 + 3_600_000).ok).toBe(false); // expired
    expect(resolveReceiptLink(w.db, tokenOf(long.url), t0 + 24 * 3_600_000 - 1).ok).toBe(true);
    expect(resolveReceiptLink(w.db, tokenOf(long.url), t0 + 24 * 3_600_000 + 1).ok).toBe(false);
    expect(listReceiptLinks(w.db, w.operator, 1, t0 + 25 * 3_600_000).every((l) => l.status === "EXPIRED")).toBe(true);
  });

  it("revocation works immediately and is audited", () => {
    const l = mk("farmer-a");
    const tok = tokenOf(l.url);
    expect(resolveReceiptLink(w.db, tok).ok).toBe(true);
    revokeReceiptLink(w.db, w.operator, l.id);
    expect(resolveReceiptLink(w.db, tok).ok).toBe(false);
    expect(listReceiptLinks(w.db, w.operator, 1)[0].status).toBe("REVOKED");
    expect((w.db.prepare("SELECT action FROM audit_events WHERE action LIKE 'RECEIPT_LINK_%'").all() as { action: string }[]).map((r) => r.action)).toEqual(["RECEIPT_LINK_CREATED", "RECEIPT_LINK_REVOKED"]);
    revokeReceiptLink(w.db, w.operator, l.id); // revoking twice is harmless
    expect(() => revokeReceiptLink(w.db, w.operator, 9999)).toThrow(NotFoundError);
  });

  it("counts views", () => {
    const tok = tokenOf(mk("farmer-a").url);
    resolveReceiptLink(w.db, tok);
    resolveReceiptLink(w.db, tok);
    expect(listReceiptLinks(w.db, w.operator, 1)[0].viewCount).toBe(2);
  });

  it("the receipt follows the real payout state", async () => {
    const tok = tokenOf(mk("farmer-a").url);
    const before = resolveReceiptLink(w.db, tok);
    expect(before.ok && before.receipt.statusWords).toBe("Not started");
    await verifyAndApprove(w);
    await startPayouts(w.deps, w.operator, 1);
    await authorizePayouts(w.deps, w.operator, 1);
    await handlePayoutCallback(w.deps, w.operator, approvedQuery(w.provider.lastGrant!));
    const after = resolveReceiptLink(w.db, tok);
    expect(after.ok && after.receipt.statusWords).toBe("Paid");
  });
});

describe("public receipt page", () => {
  it("serves one receipt with no-store, noindex and no-referrer headers", () => {
    const tok = tokenOf(mk("farmer-a").url);
    const r = handleReceiptRequest(w.db, tok, "ip-1");
    expect(r.status).toBe(200);
    expect(r.headers["Cache-Control"]).toMatch(/no-store/);
    expect(r.headers["X-Robots-Tag"]).toMatch(/noindex/);
    expect(r.headers["Referrer-Policy"]).toBe("no-referrer");
    expect(r.headers["Content-Security-Policy"]).toMatch(/default-src 'none'/);
    expect(r.html).toContain("3.70 USD");
    expect(r.html).toContain("TEST NETWORK, PLAY MONEY ONLY");
    expect(r.html).toContain('name="viewport"');
    expect(r.html).not.toMatch(/interledger|https?:\/\/|tel:|<script/i);
    expect(r.html).not.toContain("3.20");
    expect(r.html).not.toContain("Farmer B");
  });

  it("unknown, malformed, expired and revoked links get the SAME answer", () => {
    const t0 = Date.parse("2026-11-18T12:00:00Z");
    const expired = tokenOf(mk("farmer-a", 1, t0).url);
    const revoked = mk("farmer-b");
    revokeReceiptLink(w.db, w.operator, revoked.id);
    const answers = [
      handleReceiptRequest(w.db, "A".repeat(43), "ip-2"),
      handleReceiptRequest(w.db, "short", "ip-2"),
      handleReceiptRequest(w.db, expired, "ip-2", t0 + 2 * 3_600_000),
      handleReceiptRequest(w.db, tokenOf(revoked.url), "ip-2"),
    ];
    for (const a of answers) {
      expect(a.status).toBe(404);
      expect(a.html).toBe(answers[0].html);
      expect(a.headers["Cache-Control"]).toMatch(/no-store/);
      expect(a.headers["X-Robots-Tag"]).toMatch(/noindex/);
    }
    expect(answers[0].html).not.toContain("USD");
  });

  it("is rate limited", () => {
    let last = 0;
    for (let i = 0; i < 40; i++) last = handleReceiptRequest(w.db, "A".repeat(43), "ip-3").status;
    expect(last).toBe(429);
    expect(handleReceiptRequest(w.db, "A".repeat(43), "ip-other").status).toBe(404);
  });

  it("escapes anything it prints", () => {
    expect(escapeHtml(`<b onclick="x">&'`)).toBe("&lt;b onclick=&quot;x&quot;&gt;&amp;&#39;");
    w.db.prepare("UPDATE orders SET order_ref = '<img src=x>' WHERE id = 1").run();
    const r = handleReceiptRequest(w.db, tokenOf(mk("farmer-a").url), "ip-4");
    expect(r.html).toContain("&lt;img src=x&gt;");
    expect(r.html).not.toContain("<img");
  });

  it("the framework config also sets the headers for /r/*", async () => {
    const rules = await nextConfig.headers!();
    const rule = rules.find((x) => x.source === "/r/:path*")!;
    const get = (k: string) => rule.headers.find((h) => h.key === k)?.value ?? "";
    expect(get("Cache-Control")).toMatch(/no-store/);
    expect(get("X-Robots-Tag")).toMatch(/noindex/);
    expect(get("Referrer-Policy")).toBe("no-referrer");
    expect(receiptHeaders()["Cache-Control"]).toMatch(/no-store/);
  });
});
