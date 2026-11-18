// Payout state machine. Exactly six states and ONE function that decides every change.

export const PAYOUT_STATES = ["CREATED", "AWAITING_CONSENT", "SUBMITTED", "UNKNOWN", "FAILED", "CONFIRMED"] as const;
export type PayoutState = (typeof PAYOUT_STATES)[number];

// Which moves are allowed. Anything not listed here throws.
const ALLOWED: Record<PayoutState, readonly PayoutState[]> = {
  CREATED: ["AWAITING_CONSENT"],
  AWAITING_CONSENT: ["SUBMITTED"],
  SUBMITTED: ["CONFIRMED", "FAILED", "UNKNOWN"],
  UNKNOWN: ["CONFIRMED", "FAILED"], // only after reconciliation (see below)
  FAILED: [],
  CONFIRMED: [],
};

export class InvalidTransitionError extends Error {}

/**
 * The only place that decides whether a state change is legal.
 * Returns the new state, or throws. Leaving UNKNOWN requires `reconciled: true`,
 * meaning we re-read the real payment from the provider first.
 */
export function transition(from: PayoutState, to: PayoutState, opts: { reconciled?: boolean } = {}): PayoutState {
  if (!PAYOUT_STATES.includes(from) || !PAYOUT_STATES.includes(to)) {
    throw new InvalidTransitionError(`Unknown state in ${from} -> ${to}`);
  }
  if (!ALLOWED[from].includes(to)) throw new InvalidTransitionError(`Transition ${from} -> ${to} is not allowed`);
  if (from === "UNKNOWN" && !opts.reconciled) {
    throw new InvalidTransitionError("UNKNOWN can only be resolved after reconciliation");
  }
  return to;
}

/**
 * Starting a NEW attempt for a payout. This is deliberately NOT a normal transition: FAILED stays final for the
 * attempt that failed. It is allowed only from FAILED, only when the provider confirmed the failure
 * (`providerConfirmedFailure`), and the caller must be an operator action. Returns the starting state for the new attempt.
 */
export function beginNewAttempt(from: PayoutState, providerConfirmedFailure: boolean): PayoutState {
  if (from !== "FAILED") throw new InvalidTransitionError(`A new attempt is only allowed after FAILED (was ${from})`);
  if (!providerConfirmedFailure) throw new InvalidTransitionError("A new attempt needs a provider-confirmed failure");
  return "CREATED";
}

/**
 * "Cancelled" is not a state. If the buyer/operator rejects consent, the payout stays in
 * AWAITING_CONSENT and consent_outcome is set to REJECTED. Anything else throws.
 */
export function rejectConsent(state: PayoutState): { state: PayoutState; consentOutcome: "REJECTED" } {
  if (state !== "AWAITING_CONSENT") {
    throw new InvalidTransitionError(`Consent can only be rejected while AWAITING_CONSENT (was ${state})`);
  }
  return { state, consentOutcome: "REJECTED" };
}

/** One dictionary for all wording: dashboard (operator) words and plain farmer words. */
export const STATE_WORDS: Record<PayoutState, { dashboard: string; farmer: string; buyer: string }> = {
  CREATED: { dashboard: "Created", farmer: "Not started", buyer: "Quote ready, approval needed" },
  AWAITING_CONSENT: { dashboard: "Awaiting consent", farmer: "Approval needed", buyer: "Waiting for your approval in the wallet" },
  SUBMITTED: { dashboard: "Submitted", farmer: "Processing", buyer: "Processing" },
  UNKNOWN: { dashboard: "Unknown: needs reconciliation", farmer: "Needs checking", buyer: "Needs checking" },
  FAILED: { dashboard: "Failed", farmer: "Failed", buyer: "Failed, you can get a new quote" },
  CONFIRMED: { dashboard: "Confirmed", farmer: "Paid", buyer: "Paid" },
};

/** Wording used when no payout exists yet for an allocation. */
export const NO_PAYOUT_WORDS = { dashboard: "Not started", farmer: "Not started", buyer: "Not started" };
