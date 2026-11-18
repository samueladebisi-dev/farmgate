# Test evidence

How to read this file:
- **Automated rows** name the test file and test. They were last run together with `npm run verify` on **2026-11-18** and passed. Re-run `npm run verify` and update the date and result if anything changes.
- **Live rows** hold provider resource ids from the Interledger test network. A cell reading `TO FILL AFTER LIVE RUN` has not been done yet. Blank means not measured. Nothing in a blank has been assumed.
- All money is play money on the test network.

## A. Live evidence already held

### A1. Buyer payment you supplied

| Feature | Test or provider resource ID | Date | Result |
|---|---|---|---|
| Buyer-to-cooperative transfer, incoming payment | `7d63d740-348e-4f0a-9d10-4870b5bd3b7c` | TO CONFIRM | Supplied by the project owner |
| Same transfer, quote id and outgoing payment id (the provider used the same id for both) | `01b337c3-7182-4240-9bd8-5f9472896fb9` | TO CONFIRM | Supplied by the project owner |
| Amounts | 10.03 EUR debited from the buyer for 10.00 USD received by the cooperative | TO CONFIRM | Supplied by the project owner |

**Note to check before showing these.** When this file was written, neither of those two ids appeared in the app's local database. The app's own live buyer payment (A2 below) has different ids. Both can be genuine (for example, one from the earlier proof in `spike/` and one from the app), but confirm which run each id belongs to before you present them as the same event.

### A2. Buyer payment made through the app (read from the local database)

| Feature | Test or provider resource ID | Date | Result |
|---|---|---|---|
| Incoming payment at the cooperative | `49170184-a823-4193-9bdf-10fe6ad3e1f6` | 2026-11-18 | Provider reported completed, received 10.00 USD |
| Quote id and outgoing payment id (same id) | `a861ffd8-5aaa-47e2-83ee-4600e2fa22bc` | 2026-11-18 | Quoted debit 10.03 EUR; provider reported sent 10.03 EUR |
| Order PO-0124 | status RECEIVED, confirmed received 10.00 USD | 2026-11-18 | Set only after the provider showed the incoming payment complete with the exact amount |

These are ids inside the provider's resource URLs (`.../incoming-payments/<id>`, `.../quotes/<id>`, `.../outgoing-payments/<id>`). Source: the app's local database and audit log, read on 2026-11-18. The audit log timestamps are about 04:27 to 04:28 UTC.

## B. Live evidence still to collect

| Feature | Test or provider resource ID | Date | Result |
|---|---|---|---|
| Payee verification of the four wallets against the real provider | TO FILL AFTER LIVE RUN | | |
| Payout Farmer A: incoming payment id | TO FILL AFTER LIVE RUN | | |
| Payout Farmer A: quote id | TO FILL AFTER LIVE RUN | | |
| Payout Farmer A: outgoing payment id | TO FILL AFTER LIVE RUN | | |
| Payout Farmer B: incoming / quote / outgoing ids | TO FILL AFTER LIVE RUN | | |
| Payout Farmer C: incoming / quote / outgoing ids | TO FILL AFTER LIVE RUN | | |
| Payout logistics: incoming / quote / outgoing ids | TO FILL AFTER LIVE RUN | | |
| Declined consent on the cooperative wallet (genuine record): audit event id and order | TO FILL AFTER LIVE RUN | | |
| Did one wallet approval cover all four payouts? (audit "Payout submission summary") | TO FILL AFTER LIVE RUN | | |
| Quoted debit versus amount received for the USD-to-USD payouts | TO FILL AFTER LIVE RUN | | |
| Order reaches COMPLETED from provider-confirmed payouts | TO FILL AFTER LIVE RUN | | |
| Wallet balances before and after | TO FILL AFTER LIVE RUN | | |

## C. Manual checks (see `docs/VERIFICATION_CHECKLIST.md`)

| Feature | Test or provider resource ID | Date | Result |
|---|---|---|---|
| Farmer receipt on a real phone | TO FILL AFTER LIVE RUN | | |
| Receipt link and QR on a phone, then revoked | TO FILL AFTER LIVE RUN | | |
| 320 px width: login, buyer, farmer, receipt, operator pages | TO FILL AFTER LIVE RUN | | |
| Slow-network load (throttle profile and measured numbers) | TO FILL AFTER LIVE RUN | | |
| No secrets in git before publishing (last line of the scan) | TO FILL AFTER LIVE RUN | | |
| Demo rehearsal with a timer | TO FILL AFTER LIVE RUN | | |

## D. Automated tests (fake provider unless stated)

### Money and states

| Feature | Test | Date | Result |
|---|---|---|---|
| Worked example: A 37.00, B 32.00, C 23.00, logistics 3.00, cooperative 5.00, total 100.00 | `lib/money.test.ts`: "worked order at 100.00" (4 tests) | 2026-11-18 | PASS |
| Test order at 10.00 and every multiple of 10.00 adds up exactly | `lib/money.test.ts`: "configurable order total" | 2026-11-18 | PASS |
| Allocation total must equal confirmed received; quoted debits at most received minus reserve | `lib/money.test.ts`: "invariants" | 2026-11-18 | PASS |
| Largest-remainder split, ties broken by id | `lib/money.test.ts`: "largestRemainder" | 2026-11-18 | PASS |
| Whole-number money, no floats (parse and format) | `lib/money.test.ts`: "parse and format" | 2026-11-18 | PASS |
| Exactly six states; allowed moves only; UNKNOWN resolves only after reconciliation | `lib/payout-state.test.ts`: "payout state machine" | 2026-11-18 | PASS |
| "Cancelled" is not a state; declined consent is an outcome note | `lib/payout-state.test.ts`: "consent rejection is an outcome flag, not a state"; `lib/db.test.ts`: "consent_outcome can only be set while AWAITING_CONSENT; 'CANCELLED' is not a state" | 2026-11-18 | PASS |
| New attempt only from a provider-confirmed FAILED | `lib/payout-state.test.ts`: "a new attempt starts only from a provider-confirmed FAILED" | 2026-11-18 | PASS |
| Plain-word wording for every state | `lib/payout-state.test.ts`: "has dashboard and farmer words for every state" | 2026-11-18 | PASS |

### Database rules

| Feature | Test | Date | Result |
|---|---|---|---|
| Audit log cannot be changed or deleted | `lib/db.test.ts`: "audit_events cannot be updated or deleted" | 2026-11-18 | PASS |
| Audit metadata is redacted | `lib/db.test.ts`: "audit metadata is redacted" | 2026-11-18 | PASS |
| Payout uniqueness (idempotency key; allocation, version, purpose; attempt numbers) | `lib/db.test.ts`: "payout operation uniqueness ...", "attempt numbers are unique per operation" | 2026-11-18 | PASS |

### Buyer payment (fake provider)

| Feature | Test | Date | Result |
|---|---|---|---|
| Quote created for the fixed amount and stored; expired quote blocks authorization | `lib/payments.test.ts`: "quote" | 2026-11-18 | PASS |
| Callback checks: wrong session, no login, replay, simultaneous callbacks, bad hash, tampering, order or purpose mismatch, expired session, other buyer | `lib/payments.test.ts`: "callback rejection cases" | 2026-11-18 | PASS |
| Declined consent is CONSENT_REJECTED / CANCELLED, never FAILED; a new attempt is possible | `lib/payments.test.ts`: "buyer declined consent: CONSENT_REJECTED / CANCELLED, never FAILED, and a new attempt is possible" | 2026-11-18 | PASS |
| Timeout after submit becomes UNKNOWN, is reconciled, never blindly retried | `lib/payments.test.ts`: "timeout after submit: UNKNOWN, reconciled, never blindly retried" | 2026-11-18 | PASS |
| Reconciliation rules: exact, under, over, duplicate incoming payment | `lib/reconcile-rules.test.ts`; `lib/payments.test.ts`: "reconciliation rules against the provider" | 2026-11-18 | PASS |
| Tokens encrypted at rest and not in the audit log | `lib/payments.test.ts`: "tokens are encrypted at rest and never appear in the audit log" | 2026-11-18 | PASS |

### Payees, approval and payouts (fake provider)

| Feature | Test | Date | Result |
|---|---|---|---|
| Payee checks: typo address, wrong asset, wrong scale, private or non-https host (refused before any lookup), changed wallet | `lib/payees.test.ts`: "payee verification"; `lib/payee-url.test.ts` | 2026-11-18 | PASS |
| Approval blocked until all four payees are verified; allocations must equal received; later change invalidates approval | `lib/payees.test.ts`: "approval" | 2026-11-18 | PASS |
| Double click creates one set of payout operations (two concurrent requests) | `lib/payouts.test.ts`: "double click creates ONE set of operations (two concurrent requests)" | 2026-11-18 | PASS |
| Expired quote blocks submission | `lib/payouts.test.ts`: "quote expires while the owner is in the wallet ..." and "quote expired at authorization ..." | 2026-11-18 | PASS |
| Insufficient funds blocks release | `lib/payouts.test.ts`: "insufficient funds blocks release with a clear message" | 2026-11-18 | PASS |
| Timeout becomes UNKNOWN and blocks retry | `lib/payouts.test.ts`: "timeout after submitting becomes UNKNOWN, is reconciled, blocks retry, and is never blindly retried" | 2026-11-18 | PASS |
| Declined consent is not FAILED; operator can try again | `lib/payouts.test.ts`: "declined consent: CONSENT_REJECTED / CANCELLED, payouts stay AWAITING_CONSENT, none FAILED, operator can retry" | 2026-11-18 | PASS |
| Wrong role is rejected | `lib/payouts.test.ts`: "only operators can start, authorize, reconcile or retry"; "callback checks are shared with the buyer flow ..." | 2026-11-18 | PASS |
| Retry only after a confirmed failure | `lib/payouts.test.ts`: "a clear refusal is FAILED; a new attempt is allowed only then, only for an operator, with a new attempt number" | 2026-11-18 | PASS |
| One approval covering one payment only: fall back to one approval per recipient | `lib/payouts.test.ts`: "a consent that covers only ONE payment ..." (fake provider behaviour, NOT observed live) | 2026-11-18 | PASS |

### Orders, demo reset, receipts

| Feature | Test | Date | Result |
|---|---|---|---|
| Create order: validation, decimal price to whole cents, PO-0125 numbering, unapproved allocations | `lib/orders.test.ts`: "planOrder (money engine)", "Create order" | 2026-11-18 | PASS |
| Many orders; buyers and farmers see only their own | `lib/orders.test.ts`: "many orders: nothing assumes a single order" | 2026-11-18 | PASS |
| Demo reset never touches provider payments, payout history, attempts or audit events | `lib/orders.test.ts`: "creates a new order only: provider payments, payout history, attempts and audit events are untouched" | 2026-11-18 | PASS |
| Text receipt under 160 characters for every state, plain ASCII | `lib/receipts.test.ts`: "is under 160 characters for EVERY state ..." | 2026-11-18 | PASS |
| Receipt link: expired, revoked, other recipient, token unguessable and stored only as a hash, 24-hour cap | `lib/receipts.test.ts`: "receipt links" | 2026-11-18 | PASS |
| Public receipt page headers (no-store, noindex, no-referrer), identical answer for bad links, rate limit, escaping | `lib/receipts.test.ts`: "public receipt page" | 2026-11-18 | PASS |
| Farmer cannot read another farmer's data | `lib/access.test.ts`: "farmer A cannot read farmer B or C"; `lib/receipts.test.ts`: "a farmer can read only their own record (cross-farmer access)"; `lib/payouts.test.ts`: "farmer sees only their own amount, plain-word status and short reference" | 2026-11-18 | PASS |

### Security

| Feature | Test | Date | Result |
|---|---|---|---|
| Every page and API route against not-logged-in, buyer, operator, farmer (own) and farmer (other); fails if a route is not listed | `tests/access-matrix.test.ts`: "every route is in the matrix", "access matrix" | 2026-11-18 | PASS |
| Cross-site and origin-less requests refused on every state-changing route, with nothing changed | `tests/access-matrix.test.ts`: "CSRF protection" | 2026-11-18 | PASS |
| Rate limit on every route: the limit-th call passes, the next is refused; limits table matches the routes | `tests/access-matrix.test.ts`: "rate limits", "every route names a rate limit ..." | 2026-11-18 | PASS |
| Login brute-force limits, generic error, no password in the audit log | `tests/hardening.test.ts`: "login: brute-force protection" | 2026-11-18 | PASS |
| Logout really ends the session; expired and tampered sessions refused; cookie HttpOnly, SameSite, Secure when not localhost | `tests/hardening.test.ts`: "sessions and cookies" | 2026-11-18 | PASS |
| Security headers in the framework configuration | `tests/hardening.test.ts`: "security headers" | 2026-11-18 | PASS |
| Strict input validation: unknown fields, wrong types, bad ids, stray query strings refused | `tests/hardening.test.ts`: "input validation", "callback query checks" | 2026-11-18 | PASS |
| No secrets in the audit log, printed output, or plain database columns after the main flows; no logging statements in app code | `tests/secrets-leak.test.ts` | 2026-11-18 | PASS |
| Browser bundle contains none of the `.env` values and not the words PRIVATE KEY; a real production server sends the security headers and keeps strangers out | `tests/bundle.test.ts` | 2026-11-18 | PASS |
| Secrets scan of tracked and untracked-not-ignored files and all git history; private.key, .env and database files never committed | `npm run secrets:scan` | 2026-11-18 | PASS ("OK: no secrets found") |
| Type-check, production build, all tests, secrets scan in one command | `npm run verify` | 2026-11-18 | PASS |
