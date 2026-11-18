import { beforeEach, describe, expect, it } from "vitest";
import { audit } from "./audit";
import { applyMigrations, openDb, type Db } from "./db";
import { createSessionToken, readSessionToken } from "./session";
import { hashPassword, verifyPassword } from "./password";
import { seedDatabase } from "./seed";

const passwords = { buyer: "b", operator: "o", farmerA: "a", farmerB: "bb", farmerC: "c" };
let db: Db;
beforeEach(() => {
  db = openDb(":memory:");
  applyMigrations(db);
  seedDatabase(db, { orderTotalMinor: 10000, passwords });
});

describe("database rules", () => {
  it("seeds PO-0124 with allocations that sum to the expected receive", () => {
    const o = db.prepare("SELECT expected_receive_minor e FROM orders WHERE order_ref='PO-0124'").get() as { e: number };
    const s = db.prepare("SELECT SUM(net_minor) s FROM allocations").get() as { s: number };
    expect(o.e).toBe(10000);
    expect(s.s).toBe(10000);
  });

  it("audit_events cannot be updated or deleted", () => {
    audit(db, { actor: "t", action: "x", entityType: "e", entityId: 1 });
    expect(() => db.prepare("UPDATE audit_events SET actor='z'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM audit_events").run()).toThrow(/append-only/);
  });

  it("audit metadata is redacted", () => {
    audit(db, { actor: "t", action: "x", entityType: "e", entityId: 1, metadata: { accessToken: "abc", nested: { privateKey: "k", ok: 1 }, amount: 5 } });
    const m = db.prepare("SELECT metadata FROM audit_events WHERE action='x'").get() as { metadata: string };
    expect(m.metadata).not.toContain("abc");
    expect(JSON.parse(m.metadata)).toEqual({ accessToken: "[redacted]", nested: { privateKey: "[redacted]", ok: 1 }, amount: 5 });
  });

  it("payout operation uniqueness: idempotency key and (allocation, version, purpose)", () => {
    const a = db.prepare("SELECT id FROM allocations LIMIT 1").get() as { id: number };
    const ins = db.prepare("INSERT INTO payout_operations (allocation_id, approval_version, transfer_purpose, idempotency_key) VALUES (?,?,?,?)");
    ins.run(a.id, 1, "FARMER_PAYOUT", "11111111-1111-1111-1111-111111111111");
    expect(() => ins.run(a.id, 1, "FARMER_PAYOUT", "22222222-2222-2222-2222-222222222222")).toThrow(/UNIQUE/);
    expect(() => ins.run(a.id, 2, "FARMER_PAYOUT", "11111111-1111-1111-1111-111111111111")).toThrow(/UNIQUE/);
    expect(() => ins.run(a.id, 2, "FARMER_PAYOUT", "33333333-3333-3333-3333-333333333333")).not.toThrow();
  });

  it("attempt numbers are unique per operation", () => {
    const a = db.prepare("SELECT id FROM allocations LIMIT 1").get() as { id: number };
    const op = Number(db.prepare("INSERT INTO payout_operations (allocation_id, approval_version, transfer_purpose, idempotency_key) VALUES (?,1,'FARMER_PAYOUT','k1')").run(a.id).lastInsertRowid);
    const ins = db.prepare("INSERT INTO payout_attempts (operation_id, attempt_number) VALUES (?,?)");
    ins.run(op, 1);
    expect(() => ins.run(op, 1)).toThrow(/UNIQUE/);
    expect(() => ins.run(op, 2)).not.toThrow();
  });

  it("consent_outcome can only be set while AWAITING_CONSENT; 'CANCELLED' is not a state", () => {
    const a = db.prepare("SELECT id FROM allocations LIMIT 1").get() as { id: number };
    const op = Number(db.prepare("INSERT INTO payout_operations (allocation_id, approval_version, transfer_purpose, idempotency_key) VALUES (?,1,'FARMER_PAYOUT','k2')").run(a.id).lastInsertRowid);
    expect(() => db.prepare("UPDATE payout_operations SET consent_outcome='REJECTED' WHERE id=?").run(op)).toThrow(); // still CREATED
    db.prepare("UPDATE payout_operations SET state='AWAITING_CONSENT' WHERE id=?").run(op);
    expect(() => db.prepare("UPDATE payout_operations SET consent_outcome='REJECTED' WHERE id=?").run(op)).not.toThrow();
    expect(() => db.prepare("UPDATE payout_operations SET state='CANCELLED' WHERE id=?").run(op)).toThrow();
  });
});

describe("passwords and session cookie", () => {
  it("hashes and verifies passwords", () => {
    const h = hashPassword("secret");
    expect(verifyPassword("secret", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
  });
  const key = "test-secret-test-secret";
  it("accepts a valid token, rejects tampered, wrong-key and expired tokens", () => {
    const t = createSessionToken(7, Date.now(), key);
    expect(readSessionToken(t, Date.now(), key)?.uid).toBe(7);
    expect(readSessionToken(t.replace(/.$/, (c) => (c === "a" ? "b" : "a")), Date.now(), key)).toBeNull();
    const [body, sig] = t.split(".");
    const forged = Buffer.from(JSON.stringify({ uid: 1, sid: "x", exp: 9999999999 })).toString("base64url");
    expect(readSessionToken(`${forged}.${sig}`, Date.now(), key)).toBeNull();
    expect(readSessionToken(t, Date.now(), "another-secret-another")).toBeNull();
    expect(readSessionToken(t, Date.now() + 9 * 3600 * 1000, key)).toBeNull();
    expect(readSessionToken(undefined, Date.now(), key)).toBeNull();
    expect(body.length).toBeGreaterThan(0);
  });
});
