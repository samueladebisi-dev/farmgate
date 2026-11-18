// ONE table of rate limits (per user per minute unless noted). Every route and the login use a name from here,
// so the limits are consistent and can be tested as a list.
export const LIMITS = {
  loginUser: { max: 5, windowMs: 60_000 }, // per username: brute-force protection
  loginIp: { max: 20, windowMs: 60_000 }, // per client address
  read: { max: 120, windowMs: 60_000 },
  quote: { max: 10, windowMs: 60_000 },
  authorize: { max: 10, windowMs: 60_000 },
  reconcile: { max: 10, windowMs: 60_000 },
  callback: { max: 20, windowMs: 60_000 },
  verifyPayees: { max: 5, windowMs: 60_000 },
  approve: { max: 10, windowMs: 60_000 },
  payoutStart: { max: 5, windowMs: 60_000 },
  payoutRequote: { max: 10, windowMs: 60_000 },
  payoutAuthorize: { max: 10, windowMs: 60_000 },
  payoutRetry: { max: 5, windowMs: 60_000 },
  payoutReconcile: { max: 10, windowMs: 60_000 },
  orderPreview: { max: 60, windowMs: 60_000 },
  orderCreate: { max: 20, windowMs: 60_000 },
  demoReset: { max: 5, windowMs: 60_000 },
  receiptLink: { max: 10, windowMs: 60_000 },
  receiptRevoke: { max: 20, windowMs: 60_000 },
  receiptPublic: { max: 30, windowMs: 60_000 }, // per client address, no login
} as const;

export type LimitName = keyof typeof LIMITS;
