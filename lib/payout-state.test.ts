import { describe, expect, it } from "vitest";
import { beginNewAttempt, PAYOUT_STATES, rejectConsent, STATE_WORDS, transition, type PayoutState } from "./payout-state";

const ALLOWED: [PayoutState, PayoutState][] = [
  ["CREATED", "AWAITING_CONSENT"],
  ["AWAITING_CONSENT", "SUBMITTED"],
  ["SUBMITTED", "CONFIRMED"],
  ["SUBMITTED", "FAILED"],
  ["SUBMITTED", "UNKNOWN"],
];

describe("payout state machine", () => {
  it("has exactly six states", () => {
    expect([...PAYOUT_STATES]).toEqual(["CREATED", "AWAITING_CONSENT", "SUBMITTED", "UNKNOWN", "FAILED", "CONFIRMED"]);
  });

  it("allows the listed transitions", () => {
    for (const [a, b] of ALLOWED) expect(transition(a, b)).toBe(b);
  });

  it("UNKNOWN resolves only after reconciliation", () => {
    expect(() => transition("UNKNOWN", "CONFIRMED")).toThrow();
    expect(() => transition("UNKNOWN", "FAILED")).toThrow();
    expect(transition("UNKNOWN", "CONFIRMED", { reconciled: true })).toBe("CONFIRMED");
    expect(transition("UNKNOWN", "FAILED", { reconciled: true })).toBe("FAILED");
    expect(() => transition("UNKNOWN", "SUBMITTED", { reconciled: true })).toThrow();
  });

  it("rejects every other pair", () => {
    const ok = new Set(ALLOWED.map(([a, b]) => `${a}>${b}`).concat(["UNKNOWN>CONFIRMED", "UNKNOWN>FAILED"]));
    for (const a of PAYOUT_STATES)
      for (const b of PAYOUT_STATES) {
        if (ok.has(`${a}>${b}`)) continue;
        expect(() => transition(a, b, { reconciled: true }), `${a} -> ${b}`).toThrow();
      }
  });

  it("final states cannot move", () => {
    for (const b of PAYOUT_STATES) {
      expect(() => transition("CONFIRMED", b, { reconciled: true })).toThrow();
      expect(() => transition("FAILED", b, { reconciled: true })).toThrow();
    }
  });

  it("rejects unknown state names (e.g. CANCELLED)", () => {
    expect(() => transition("AWAITING_CONSENT", "CANCELLED" as PayoutState)).toThrow();
    expect(() => transition("CANCELLED" as PayoutState, "CREATED")).toThrow();
  });

  it("consent rejection is an outcome flag, not a state", () => {
    expect(rejectConsent("AWAITING_CONSENT")).toEqual({ state: "AWAITING_CONSENT", consentOutcome: "REJECTED" });
    for (const s of PAYOUT_STATES) if (s !== "AWAITING_CONSENT") expect(() => rejectConsent(s)).toThrow();
  });

  it("has dashboard and farmer words for every state", () => {
    expect(STATE_WORDS.CREATED.farmer).toBe("Not started");
    expect(STATE_WORDS.AWAITING_CONSENT.farmer).toBe("Approval needed");
    expect(STATE_WORDS.SUBMITTED.farmer).toBe("Processing");
    expect(STATE_WORDS.UNKNOWN.farmer).toBe("Needs checking");
    expect(STATE_WORDS.FAILED.farmer).toBe("Failed");
    expect(STATE_WORDS.CONFIRMED.farmer).toBe("Paid");
    for (const s of PAYOUT_STATES) expect(STATE_WORDS[s].dashboard.length).toBeGreaterThan(0);
  });

  it("a new attempt starts only from a provider-confirmed FAILED", () => {
    expect(beginNewAttempt("FAILED", true)).toBe("CREATED");
    expect(() => beginNewAttempt("FAILED", false)).toThrow();
    for (const s of PAYOUT_STATES) if (s !== "FAILED") expect(() => beginNewAttempt(s, true), s).toThrow();
    // the normal transition table is untouched: FAILED is still final
    expect(() => transition("FAILED", "CREATED", { reconciled: true })).toThrow();
  });
});
