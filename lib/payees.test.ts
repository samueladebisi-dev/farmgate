import { beforeEach, describe, expect, it } from "vitest";
import { ForbiddenError } from "./access";
import { approveOrder, assertApprovalIntact, getReview } from "./approval";
import { assertPayeesVerified, verifyPayees } from "./payees";
import { PaymentError } from "./payments";
import { auditActions, makeWorld, markReceived, URLS, verifyAndApprove, type World } from "./test-world";

let w: World;
beforeEach(() => {
  w = makeWorld();
});
const verifiedOwners = () => (w.db.prepare("SELECT owner FROM wallets WHERE verified_by IS NOT NULL ORDER BY owner").all() as { owner: string }[]).map((r) => r.owner);
const setUrl = (owner: string, url: string) => w.db.prepare("UPDATE wallets SET canonical_url = ? WHERE owner = ?").run(url, owner);

describe("payee verification", () => {
  it("verifies all four payees, storing who confirmed and the provider's public name", async () => {
    const r = await verifyPayees(w.deps, w.operator, 1);
    expect(r.every((x) => x.ok)).toBe(true);
    expect(verifiedOwners()).toEqual(["farmer-a", "farmer-b", "farmer-c", "logistics"]);
    const row = w.db.prepare("SELECT verified_by, verified_at, verified_public_name FROM wallets WHERE owner = 'farmer-a'").get() as { verified_by: number; verified_at: string; verified_public_name: string };
    expect(row.verified_by).toBe(w.operator.id);
    expect(row.verified_public_name).toBe("Public argus-farmer-a");
    expect(auditActions(w.db).filter((a) => a === "PAYEE_VERIFIED")).toHaveLength(4);
  });

  it("only operators can verify", async () => {
    await expect(verifyPayees(w.deps, w.buyer, 1)).rejects.toThrow(ForbiddenError);
    await expect(verifyPayees(w.deps, { id: 9, role: "farmer", sessionId: "x" }, 1)).rejects.toThrow(ForbiddenError);
  });

  it("typo URL: the provider does not know it, so it is not verified", async () => {
    setUrl("farmer-a", "https://ilp.interledger-test.dev/argus-farmr-a");
    const r = await verifyPayees(w.deps, w.operator, 1);
    expect(r.find((x) => x.owner === "farmer-a")).toMatchObject({ ok: false });
    expect(r.find((x) => x.owner === "farmer-a")?.reason).toMatch(/lookup failed|404/i);
    expect(verifiedOwners()).toEqual(["farmer-b", "farmer-c", "logistics"]);
  });

  it("canonical URL mismatch: provider says the wallet is a different address", async () => {
    w.provider.walletOverrides.set(URLS.b, { id: "https://ilp.interledger-test.dev/someone-else" });
    const r = await verifyPayees(w.deps, w.operator, 1);
    expect(r.find((x) => x.owner === "farmer-b")?.reason).toMatch(/Canonical URL mismatch/);
  });

  it("wrong asset is refused", async () => {
    w.provider.walletOverrides.set(URLS.b, { assetCode: "EUR" });
    const r = await verifyPayees(w.deps, w.operator, 1);
    expect(r.find((x) => x.owner === "farmer-b")?.reason).toMatch(/Wrong asset/);
    expect(verifiedOwners()).not.toContain("farmer-b");
  });

  it("wrong scale is refused", async () => {
    w.provider.walletOverrides.set(URLS.c, { assetScale: 9 });
    const r = await verifyPayees(w.deps, w.operator, 1);
    expect(r.find((x) => x.owner === "farmer-c")?.reason).toMatch(/Wrong scale/);
  });

  it("private / local / non-https hosts are refused BEFORE any lookup", async () => {
    let lookups = 0;
    const orig = w.provider.getWalletStrict.bind(w.provider);
    w.provider.getWalletStrict = async (u) => {
      lookups++;
      return orig(u);
    };
    setUrl("farmer-a", "https://localhost/argus-farmer-a");
    setUrl("farmer-b", "https://192.168.1.20/argus-farmer-b");
    setUrl("farmer-c", "http://ilp.interledger-test.dev/argus-farmer-c");
    const r = await verifyPayees(w.deps, w.operator, 1);
    expect(r.filter((x) => !x.ok).map((x) => x.owner).sort()).toEqual(["farmer-a", "farmer-b", "farmer-c"]);
    expect(r.filter((x) => !x.ok).every((x) => /refused before lookup/i.test(x.reason ?? ""))).toBe(true);
    expect(lookups).toBe(1); // only logistics was looked up
  });

  it("a wallet document pointing at an unsafe server is refused", async () => {
    w.provider.walletOverrides.set(URLS.logistics, { authServer: "https://evil.example.com/auth" });
    const r = await verifyPayees(w.deps, w.operator, 1);
    expect(r.find((x) => x.owner === "logistics")?.reason).toMatch(/Unsafe server/);
  });

  it("a wallet that changes later loses its verification (provider-side change)", async () => {
    await verifyPayees(w.deps, w.operator, 1);
    w.provider.walletOverrides.set(URLS.c, { authServer: "https://auth.interledger-test.dev/another-account" });
    await expect(assertPayeesVerified(w.deps, 1)).rejects.toThrow(/changed since it was verified/);
    expect(verifiedOwners()).not.toContain("farmer-c");
    expect(auditActions(w.db)).toContain("PAYEE_VERIFICATION_FAILED");
  });

  it("a wallet that changes later loses its verification (stored-record change)", async () => {
    await verifyPayees(w.deps, w.operator, 1);
    w.db.prepare("UPDATE wallets SET public_name = 'Renamed' WHERE owner = 'farmer-a'").run();
    expect(verifiedOwners()).not.toContain("farmer-a");
    w.db.prepare("UPDATE wallets SET asset_scale = 3 WHERE owner = 'farmer-b'").run();
    expect(verifiedOwners()).toEqual(["farmer-c", "logistics"]);
  });
});

describe("approval", () => {
  it("is blocked until all four payees are verified", async () => {
    markReceived(w);
    const fp = getReview(w.deps, w.operator, 1).fingerprint;
    await expect(approveOrder(w.deps, w.operator, 1, fp)).rejects.toThrow(/not verified/);
    expect(getReview(w.deps, w.operator, 1)).toMatchObject({ canApprove: false, payeesAllVerified: false });
    await verifyPayees(w.deps, w.operator, 1);
    // verification changed the fingerprint: the old review is stale
    await expect(approveOrder(w.deps, w.operator, 1, fp)).rejects.toThrow(/Something changed/);
    expect(getReview(w.deps, w.operator, 1).canApprove).toBe(true);
  });

  it("is blocked while the order is not provider-confirmed RECEIVED", async () => {
    await verifyPayees(w.deps, w.operator, 1);
    await expect(approveOrder(w.deps, w.operator, 1, "x")).rejects.toThrow(/confirmed as received/);
  });

  it("is blocked when allocations do not equal the confirmed amount", async () => {
    markReceived(w);
    await verifyPayees(w.deps, w.operator, 1);
    w.db.prepare("UPDATE allocations SET fee_minor = fee_minor + 10, net_minor = net_minor - 10 WHERE recipient = 'farmer-a'").run(); // still sums to 1000 ...
    w.db.prepare("UPDATE allocations SET net_minor = net_minor - 10, gross_minor = gross_minor - 10 WHERE recipient = 'logistics'").run(); // ... now it does not
    await expect(approveOrder(w.deps, w.operator, 1, getReview(w.deps, w.operator, 1).fingerprint)).rejects.toThrow(/do not match/);
    expect(auditActions(w.db)).toContain("APPROVAL_BLOCKED");
  });

  it("locks the split: version, approver, status APPROVED, audit", async () => {
    await verifyAndApprove(w);
    expect(w.db.prepare("SELECT status, approval_version FROM orders WHERE id = 1").get()).toMatchObject({ status: "APPROVED", approval_version: 1 });
    const rows = w.db.prepare("SELECT approval_version, approved_by FROM allocations").all() as { approval_version: number; approved_by: number }[];
    expect(rows.every((r) => r.approval_version === 1 && r.approved_by === w.operator.id)).toBe(true);
    expect(auditActions(w.db)).toContain("SPLIT_APPROVED");
  });

  it("only operators can approve; buyers cannot see the review", async () => {
    markReceived(w);
    await expect(approveOrder(w.deps, w.buyer, 1, "x")).rejects.toThrow(ForbiddenError);
    expect(() => getReview(w.deps, w.buyer, 1)).toThrow(ForbiddenError);
  });

  it("a later change to an input invalidates the approval", async () => {
    await verifyAndApprove(w);
    assertApprovalIntact(w.deps, "test", 1); // fine now
    w.db.prepare("UPDATE allocations SET fee_minor = fee_minor + 10, net_minor = net_minor - 10 WHERE recipient = 'farmer-a'").run();
    w.db.prepare("UPDATE allocations SET fee_minor = fee_minor - 10, net_minor = net_minor + 10 WHERE recipient = 'farmer-b'").run();
    expect(() => assertApprovalIntact(w.deps, "test", 1)).toThrow(PaymentError);
    expect(w.db.prepare("SELECT status FROM orders WHERE id = 1").get()).toEqual({ status: "RECEIVED" });
    expect(auditActions(w.db)).toContain("APPROVAL_INVALIDATED");
  });
});
