import { describe, expect, it } from "vitest";
import { evaluateReceipts, type IncomingFacts } from "./reconcile-rules";

const inc = (id: string, receivedMinor: number, o: Partial<IncomingFacts> = {}): IncomingFacts => ({ id, receivedMinor, assetMatches: true, completed: true, expired: false, ...o });

describe("evaluateReceipts (expected 1000)", () => {
  it("exact match, completed: confirm", () => {
    expect(evaluateReceipts(1000, [inc("a", 1000)], null)).toEqual({ confirmIncomingId: "a", exceptions: [], waiting: false });
  });
  it("exact amount but not completed: wait, do not confirm", () => {
    const d = evaluateReceipts(1000, [inc("a", 1000, { completed: false })], null);
    expect(d.confirmIncomingId).toBeNull();
    expect(d.waiting).toBe(true);
  });
  it("nothing received yet: wait", () => {
    const d = evaluateReceipts(1000, [inc("a", 0, { completed: false })], null);
    expect(d).toMatchObject({ confirmIncomingId: null, exceptions: [], waiting: true });
  });
  it("partial but still open: wait, no exception yet", () => {
    expect(evaluateReceipts(1000, [inc("a", 400, { completed: false })], null)).toMatchObject({ confirmIncomingId: null, exceptions: [], waiting: true });
  });
  it("under, completed: blocked with UNDERPAYMENT", () => {
    const d = evaluateReceipts(1000, [inc("a", 900)], null);
    expect(d.confirmIncomingId).toBeNull();
    expect(d.exceptions.map((e) => e.code)).toEqual(["UNDERPAYMENT"]);
  });
  it("under, expired: blocked with UNDERPAYMENT", () => {
    expect(evaluateReceipts(1000, [inc("a", 900, { completed: false, expired: true })], null).exceptions[0].code).toBe("UNDERPAYMENT");
  });
  it("over: exception, never confirmed (extra is not distributed)", () => {
    const d = evaluateReceipts(1000, [inc("a", 1200)], null);
    expect(d.confirmIncomingId).toBeNull();
    expect(d.exceptions).toEqual([expect.objectContaining({ code: "OVERPAYMENT", incomingId: "a" })]);
    expect(d.exceptions[0].detail).toContain("extra 200");
  });
  it("second incoming payment for the same order: recorded as duplicate, order triggered once", () => {
    const d = evaluateReceipts(1000, [inc("a", 1000), inc("b", 1000)], null);
    expect(d.confirmIncomingId).toBe("a");
    expect(d.exceptions.map((e) => [e.code, e.incomingId])).toEqual([["DUPLICATE_PAYMENT", "b"]]);
  });
  it("after the order is already confirmed, nothing is confirmed again", () => {
    const d = evaluateReceipts(1000, [inc("a", 1000), inc("b", 1000)], "a");
    expect(d.confirmIncomingId).toBeNull();
    expect(d.exceptions.map((e) => e.incomingId)).toEqual(["b"]);
    expect(evaluateReceipts(1000, [inc("a", 1000)], "a")).toEqual({ confirmIncomingId: null, exceptions: [], waiting: false });
  });
  it("a different asset is an exception and is never confirmed", () => {
    const d = evaluateReceipts(1000, [inc("a", 1000, { assetMatches: false })], null);
    expect(d.confirmIncomingId).toBeNull();
    expect(d.exceptions[0].code).toBe("ASSET_MISMATCH");
  });
});
