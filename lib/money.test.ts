import { describe, expect, it } from "vitest";
import {
  allocateItem,
  assertAllocationMatchesReceived,
  assertDebitsWithinReceived,
  buildDemoOrder,
  buildLedger,
  formatMoney,
  largestRemainder,
  parseMajorToMinor,
} from "./money";

const worked = buildDemoOrder(10000);
const ledger = buildLedger(worked);
const byRecipient = (r: string) => ledger.entries.find((e) => e.recipient === r)!.minor;

describe("worked order at 100.00", () => {
  it("has the expected items", () => {
    expect(worked.map((i) => [i.produce, i.kg, i.priceMinorPerKg, i.grossMinor])).toEqual([
      ["Tomatoes", 20, 200, 4000],
      ["Peppers", 10, 350, 3500],
      ["Okra", 10, 250, 2500],
    ]);
  });

  it("per-farmer fee, deduction and net", () => {
    expect(allocateItem(worked[0])).toMatchObject({ grossMinor: 4000, feeMinor: 200, deductionMinor: 100, netMinor: 3700 });
    expect(allocateItem(worked[1])).toMatchObject({ grossMinor: 3500, feeMinor: 200, deductionMinor: 100, netMinor: 3200 });
    expect(allocateItem(worked[2])).toMatchObject({ grossMinor: 2500, feeMinor: 100, deductionMinor: 100, netMinor: 2300 });
  });

  it("totals", () => {
    expect(ledger.grossMinor).toBe(10000);
    expect(ledger.feesMinor).toBe(500);
    expect(ledger.logisticsMinor).toBe(300);
    expect(ledger.farmerNetsMinor).toBe(9200);
  });

  it("ledger: A 37, B 32, C 23, logistics 3, coop 5, total 100", () => {
    expect(byRecipient("farmer-a")).toBe(3700);
    expect(byRecipient("farmer-b")).toBe(3200);
    expect(byRecipient("farmer-c")).toBe(2300);
    expect(byRecipient("logistics")).toBe(300);
    expect(byRecipient("cooperative")).toBe(500);
    expect(ledger.totalMinor).toBe(10000);
  });
});

describe("configurable order total", () => {
  it("10.00 gives 2/1/1 kg and a ledger that adds up", () => {
    const small = buildDemoOrder(1000);
    expect(small.map((i) => i.kg)).toEqual([2, 1, 1]);
    const l = buildLedger(small);
    expect(l.totalMinor).toBe(1000);
    expect(l.entries.map((e) => [e.recipient, e.minor])).toEqual([
      ["farmer-a", 370], ["farmer-b", 320], ["farmer-c", 230], ["logistics", 30], ["cooperative", 50],
    ]);
  });
  it("every multiple of 10.00 sums exactly", () => {
    for (let t = 1000; t <= 100000; t += 1000) expect(buildLedger(buildDemoOrder(t)).totalMinor).toBe(t);
  });
  it("rejects totals that do not scale to whole kg", () => {
    expect(() => buildDemoOrder(1500)).toThrow();
    expect(() => buildDemoOrder(0)).toThrow();
  });
});

describe("invariants", () => {
  it("allocation total must equal confirmed received", () => {
    expect(() => assertAllocationMatchesReceived(10000, 10000)).not.toThrow();
    expect(() => assertAllocationMatchesReceived(10000, 9999)).toThrow();
    expect(() => assertAllocationMatchesReceived(10000, 10001)).toThrow();
  });
  it("sum of quoted debits <= received - reserve (reserve 0)", () => {
    expect(() => assertDebitsWithinReceived([3700, 3200, 2300, 300], 10000)).not.toThrow(); // 9500
    expect(() => assertDebitsWithinReceived([5000, 5000], 10000)).not.toThrow(); // exactly equal
    expect(() => assertDebitsWithinReceived([5000, 5001], 10000)).toThrow();
    expect(() => assertDebitsWithinReceived([5000, 5000], 10000, 1)).toThrow(); // with a reserve
  });
  it("rejects non-integers and negative nets", () => {
    expect(() => assertAllocationMatchesReceived(10.5, 10)).toThrow();
    expect(() => assertDebitsWithinReceived([1.5], 10)).toThrow();
    expect(() => allocateItem({ farmerId: "x", grossMinor: 100, feeMinor: 80, deductionMinor: 30 })).toThrow();
  });
});

describe("largestRemainder", () => {
  it("always sums exactly to the total", () => {
    const out = largestRemainder(100, [{ id: "a", weight: 1 }, { id: "b", weight: 1 }, { id: "c", weight: 1 }]);
    expect(Object.values(out).reduce((s, n) => s + n, 0)).toBe(100);
  });
  it("tie-breaks by id ascending, regardless of input order", () => {
    const parts = [{ id: "c", weight: 1 }, { id: "a", weight: 1 }, { id: "b", weight: 1 }];
    expect(largestRemainder(100, parts)).toEqual({ a: 34, b: 33, c: 33 });
    expect(largestRemainder(100, [...parts].reverse())).toEqual({ a: 34, b: 33, c: 33 });
    expect(largestRemainder(101, parts)).toEqual({ a: 34, b: 34, c: 33 });
  });
  it("gives the extra unit to the biggest remainder", () => {
    // 10 split 5:3:2 is exact; 7 split 1:1:1 -> 3,2,2 by id
    expect(largestRemainder(10, [{ id: "a", weight: 5 }, { id: "b", weight: 3 }, { id: "c", weight: 2 }])).toEqual({ a: 5, b: 3, c: 2 });
    expect(largestRemainder(5, [{ id: "a", weight: 1 }, { id: "b", weight: 3 }])).toEqual({ a: 1, b: 4 }); // 1.25 / 3.75
  });
  it("handles zero total, zero weights on some parts, and bad input", () => {
    expect(largestRemainder(0, [{ id: "a", weight: 1 }])).toEqual({ a: 0 });
    expect(largestRemainder(10, [{ id: "a", weight: 0 }, { id: "b", weight: 1 }])).toEqual({ a: 0, b: 10 });
    expect(() => largestRemainder(10, [{ id: "a", weight: 0 }])).toThrow();
    expect(() => largestRemainder(10, [])).toThrow();
    expect(() => largestRemainder(10, [{ id: "a", weight: 1 }, { id: "a", weight: 1 }])).toThrow();
    expect(() => largestRemainder(1.5, [{ id: "a", weight: 1 }])).toThrow();
  });
});

describe("parse and format", () => {
  it("round trips without floats", () => {
    expect(parseMajorToMinor("10.00", 2)).toBe(1000);
    expect(parseMajorToMinor("0.1", 2)).toBe(10);
    expect(parseMajorToMinor("37", 2)).toBe(3700);
    expect(() => parseMajorToMinor("1.234", 2)).toThrow();
    expect(() => parseMajorToMinor("abc", 2)).toThrow();
    expect(formatMoney(3700, "USD", 2)).toBe("37.00 USD");
    expect(formatMoney(5, "EUR", 2)).toBe("0.05 EUR");
  });
});
