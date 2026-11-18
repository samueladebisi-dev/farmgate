// Shared setup for tests: an in-memory database seeded with the 10.00 order, a mock provider and a fake clock.
import { createHash } from "node:crypto";
import { approveOrder, getReview } from "./approval";
import { applyMigrations, openDb, type Db } from "./db";
import { MockProvider } from "./mock-provider";
import { verifyPayees } from "./payees";
import type { Deps, PayActor } from "./payments";
import { seedDatabase } from "./seed";

process.env.SESSION_SECRET = "test-session-secret-for-token-box";

export const URLS = {
  a: "https://ilp.interledger-test.dev/argus-farmer-a",
  b: "https://ilp.interledger-test.dev/argus-farmer-b",
  c: "https://ilp.interledger-test.dev/argus-farmer-c",
  logistics: "https://ilp.interledger-test.dev/argus-logistics",
};

export type World = { db: Db; clock: { t: number }; provider: MockProvider; deps: Deps; buyer: PayActor; operator: PayActor };

export function makeWorld(): World {
  const db = openDb(":memory:");
  applyMigrations(db);
  seedDatabase(db, { orderTotalMinor: 1000, passwords: { buyer: "b", operator: "o", farmerA: "a", farmerB: "bb", farmerC: "c" } });
  const id = (u: string) => (db.prepare("SELECT id FROM users WHERE username = ?").get(u) as { id: number }).id;
  const clock = { t: Date.parse("2026-11-18T12:00:00Z") };
  const provider = new MockProvider(clock);
  return {
    db, clock, provider, deps: { db, provider, appBaseUrl: "http://localhost:3000", now: () => clock.t },
    buyer: { id: id("buyer"), role: "buyer", sessionId: "SESSION-BUYER" },
    operator: { id: id("operator"), role: "operator", sessionId: "SESSION-OP" },
  };
}

/** The buyer payment is already provider-confirmed (that flow has its own tests). */
export function markReceived(w: World) {
  w.db.prepare("UPDATE orders SET status = 'RECEIVED', confirmed_received_minor = 1000, confirmed_incoming_id = 'https://rs.test/incoming-payments/buyer', version = version + 1 WHERE id = 1").run();
}

export async function verifyAndApprove(w: World) {
  markReceived(w);
  await verifyPayees(w.deps, w.operator, 1);
  await approveOrder(w.deps, w.operator, 1, getReview(w.deps, w.operator, 1).fingerprint);
}

/** What the wallet sends back after the owner approves a payout consent. */
export function approvedQuery(g: { finishUri: string; nonce: string; serverNonce: string; authServer: string }, extra: Record<string, string> = {}): URLSearchParams {
  const q = new URLSearchParams(new URL(g.finishUri).search);
  q.set("interact_ref", "interact-ref-9");
  q.set("hash", createHash("sha256").update(`${g.nonce}\n${g.serverNonce}\ninteract-ref-9\n${g.authServer}`).digest("base64"));
  for (const [k, v] of Object.entries(extra)) v === "" ? q.delete(k) : q.set(k, v);
  return q;
}
export const declinedQuery = (g: { finishUri: string }) => new URLSearchParams({ ...Object.fromEntries(new URL(g.finishUri).searchParams), result: "grant_rejected" });

export const auditActions = (db: Db) => (db.prepare("SELECT action FROM audit_events ORDER BY id").all() as { action: string }[]).map((r) => r.action);
export const opStates = (db: Db) =>
  Object.fromEntries((db.prepare("SELECT recipient, state FROM payout_operations ORDER BY id").all() as { recipient: string; state: string }[]).map((r) => [r.recipient, r.state]));
