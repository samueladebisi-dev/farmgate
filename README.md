# Argus Payments

**TEST NETWORK, PLAY MONEY ONLY.** Nothing in this project moves real money.

## What it does, in plain English

A buyer orders produce from a farmers' cooperative and pays the cooperative once. The cooperative then has to pay several farmers and a transporter their shares, after taking a small service fee and a logistics deduction from each farmer. Argus Payments is a prototype of that workflow:

1. The operator creates an order with itemised produce (farmer, produce, whole kilos, price per kilo). The app works out each person's gross, fee, deduction and net amount before anything is saved.
2. The buyer pays the cooperative with a real Open Payments transfer. The buyer approves it in their own wallet (consent), and the app only believes the payment arrived when the **payment provider** says so.
3. The operator checks the recipients' wallet addresses, reviews the split and approves (locks) it.
4. The cooperative pays each farmer and the transporter with real Open Payments transfers, after the operator approves them in the cooperative's wallet. Every status shown comes from the provider.
5. Each farmer sees their own payment on a phone-sized page, in plain words, with a short text receipt they can copy by hand.

## Who uses it

| Role | What they do | Can see |
|---|---|---|
| **Buyer** | Gets a quote, approves the payment in their wallet | Their own orders and payment status |
| **Operator** (cooperative staff) | Creates orders, verifies payees, approves the split, releases payouts, makes receipt links | Everything, including provider ids and the audit log |
| **Farmer** (A, B, C) | Reads their own payment and receipt | Only their own amount, status and reference |
| **Receipt link holder** (no login) | Opens a link the operator made | One recipient's receipt, until the link expires or is revoked |

The logistics payee is paid like a farmer but has no login.

## What is REAL, and what is NOT

**Real**
- A genuine [Open Payments](https://openpayments.dev) transfer on the Interledger **test network**, with play money: quote, wallet consent (redirect and callback, with the interaction hash checked), and an outgoing payment created at the provider. A buyer-to-cooperative transfer has been run live (see `docs/TEST_EVIDENCE.md`).
- Statuses come from the provider, not from the app's own guess. The app re-reads the incoming and outgoing payments and only moves an order or payout forward on what they show. A payment whose outcome is unclear is marked UNKNOWN and checked before anything else happens.
- An append-only audit log, with secrets kept out of it.

**Built and tested with a fake provider, NOT yet run live (at the time of writing)**
- Payee verification, split approval, and the payouts to farmers and logistics. The automated tests use a mocked provider. A live run is step 1 of `docs/VERIFICATION_CHECKLIST.md`. Until that is done and recorded in `docs/TEST_EVIDENCE.md`, do not describe the payouts as proven on the real network.

**NOT built**
- Real money, real currencies, cash-out (turning wallet balances into cash or mobile money), SMS sending (the receipt text is for manual copy), disputes, refunds, chargebacks, production custody of keys and funds, notifications, a native mobile app, multi-cooperative or multi-tenant support. See `docs/LIMITATIONS.md`.

## Architecture

```
  Browsers: buyer / operator / farmer (phone)          Receipt link (no login)
        |  signed session cookie, same-site checks            |
        v                                                     v
 +---------------------------- Next.js app (App Router) --------------------------------+
 |  pages + API routes                                                                   |
 |    every route: role guard -> same-site check -> rate limit -> strict input check     |
 |                                                                                       |
 |  lib/money.ts          integer-only money engine and invariants                       |
 |  lib/payout-state.ts   the six payout states, one transition function, wording        |
 |  lib/payments.ts       buyer payment: quote, consent, callback checks, reconciliation |
 |  lib/payees.ts         payee verification (strict URL allow-list, asset checks)       |
 |  lib/approval.ts       review, approve and lock the split                             |
 |  lib/payouts.ts        payouts: quotes, consent, one-at-a-time submit, reconcile      |
 |  lib/receipt*.ts       recipient receipts, expiring links, public receipt page        |
 |  lib/provider.ts       the ONLY file that talks to the Open Payments SDK              |
 +-------------------------+--------------------------------+----------------------------+
                           |                                |
              SQLite file (better-sqlite3)        signed requests, key kept on the server
              orders, allocations, payouts,                   |
              grants, sessions, audit_events                  v
                                              Interledger test network wallets
                                              (authorization server + resource server)
```

## Quickstart

Requires Node 20 or newer (built on Node 24). On Windows, run commands from a terminal whose path uses the real capital letters (for example `C:\Users\...`); a lower-case drive letter makes the test runner fail with a confusing error.

```
npm install
copy .env.example .env        (Windows)   or   cp .env.example .env
```

Fill in `.env` (table below), put your private key file in the project folder as `private.key`, then:

```
npm run db:migrate     # create / update the database
npm run db:seed        # demo users, wallets and the first order PO-0124
npm run dev            # http://localhost:3000   (use "localhost", not 127.0.0.1)
```

`.env`, `private.key`, `*.db` and `node_modules` are git-ignored. Never commit them.

### Settings (`.env`)

| Variable | What it is |
|---|---|
| `COOP_WALLET_ADDRESS` | The cooperative's wallet address on the test network. This is also the app's identity when it signs requests. |
| `BUYER_WALLET_ADDRESS` | The demo buyer's wallet address. |
| `KEY_ID` | The id of the developer key registered for the cooperative wallet in the test wallet. |
| `PRIVATE_KEY_PATH` | Path to the matching private key file, normally `./private.key`. Stays on the server. |
| `SESSION_SECRET` | A long random string. It signs the login cookie and is the base for encrypting stored provider tokens. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Changing it logs everyone out and makes stored tokens unreadable. |
| `DB_PATH` | Where the SQLite file lives. Default `./data/argus.db`. |
| `ORDER_TOTAL_MAJOR` | Total of the first seeded order in USD, a multiple of `10.00`. Default `100.00`. Use `10.00` for a small test. Only used when seeding. |
| `DEMO_BUYER_PASSWORD`, `DEMO_OPERATOR_PASSWORD`, `DEMO_FARMER_A_PASSWORD`, `DEMO_FARMER_B_PASSWORD`, `DEMO_FARMER_C_PASSWORD` | Passwords for the demo users. Used only when seeding. |
| `APP_BASE_URL` | The public address of this app. The wallet sends people back to `APP_BASE_URL/api/payments/callback`, and receipt links are built from it. Default `http://localhost:3000`. If it is not localhost, the session cookie is marked Secure, so it needs `https`. |
| `NEXT_DIST_DIR` | Optional. Build folder name. Used by the bundle test; you do not normally set it. |

To change the seeded total or start over: `npm run db:reset` (deletes the local database file, then migrates and seeds).

### Demo accounts

| Username | Role | Password |
|---|---|---|
| `buyer` | Buyer | `DEMO_BUYER_PASSWORD` in your `.env` |
| `operator` | Operator | `DEMO_OPERATOR_PASSWORD` |
| `farmer-a`, `farmer-b`, `farmer-c` | Farmers | `DEMO_FARMER_A_PASSWORD`, `..._B_...`, `..._C_...` |

The wallets behind them (all on `ilp.interledger-test.dev`): buyer EUR, cooperative USD, three farmers USD, logistics USD, all with 2 decimal places.

## The full flow

1. **Create order** (operator): lines, per-farmer fee and logistics deduction, preview the allocation, save. New orders start `AWAITING_PAYMENT`. (Or press **Create fresh demo order**, which makes a new synthetic order and never touches history.)
2. **Get quote** (buyer): the app creates an incoming payment at the cooperative for the fixed amount and a quote from the buyer wallet. The buyer sees the fixed USD amount, their verified wallet and the quoted EUR debit with its expiry.
3. **Authorize in wallet** (buyer): consent in the wallet, return to the app. The app checks the session, order, purpose, expiry, one-time use and the interaction hash, then creates the outgoing payment.
4. **Reconcile**: the app reads the payments back from the provider. Only when the provider shows the incoming payment completed with exactly the expected amount does the order become `RECEIVED`.
5. **Verify payees** (operator): the four recipient wallets are looked up and checked. The operator compares the exact addresses.
6. **Review and approve** (operator): the split is locked with a fingerprint of everything reviewed. Any later change removes the approval.
7. **Start payouts** (operator): one payout per recipient, each with its own incoming payment and quote. The app checks the quoted total fits inside what was received.
8. **Authorize in wallet** (operator): one approval for all payouts if the provider allows it, otherwise one approval per recipient. A declined approval is recorded as an earlier cancelled consent, never as a failed transfer.
9. **Statuses**: the app submits payments one at a time and reads each back from the provider. When all are confirmed the order is `COMPLETED`.
10. **Farmer receipt**: each farmer sees their own amount and status, and a short text receipt. The operator can also make an expiring, revocable receipt link with a QR code for one recipient.

## The six payout states

| State | Operator sees | Farmer sees | Buyer sees (for the buyer payment) |
|---|---|---|---|
| `CREATED` | Created | Not started | Quote ready, approval needed |
| `AWAITING_CONSENT` | Awaiting consent | Approval needed | Waiting for your approval in the wallet |
| `SUBMITTED` | Submitted | Processing | Processing |
| `UNKNOWN` | Unknown: needs reconciliation | Needs checking | Needs checking |
| `FAILED` | Failed | Failed | Failed, you can get a new quote |
| `CONFIRMED` | Confirmed | Paid | Paid |

Allowed moves: `CREATED` to `AWAITING_CONSENT` to `SUBMITTED`; `SUBMITTED` to `CONFIRMED`, `FAILED` or `UNKNOWN`; `UNKNOWN` to `CONFIRMED` or `FAILED` only after reconciliation with the provider. Everything else is refused by one central function. **"Cancelled" is not a state:** a declined consent is a `consent_outcome = REJECTED` note on a payout still in `AWAITING_CONSENT`. A new attempt after a failure is a separate operator action, allowed only after a provider-confirmed `FAILED`.

## Money rules

- Money is always a whole number of the smallest unit (cents). There are no floating-point amounts anywhere. Every stored amount has its asset code and scale next to it.
- Gross = kilos x price per kilo. Net = gross - service fee - logistics deduction, and a net may not be negative (or zero, because a payout of zero cannot be made).
- Allocation total must equal the amount the provider confirmed as received.
- The sum of the quoted payout debits must not exceed the confirmed received amount minus the required reserve (the reserve is zero for now).
- Over- and underpayments are never silently accepted: underpayment blocks the order, overpayment is flagged and the extra is never distributed, a second incoming payment is recorded but does not trigger the order twice.

**Worked example** (order total 100.00 USD):

| Recipient | Produce | Gross | Fee | Logistics deduction | Net |
|---|---|---|---|---|---|
| Farmer A | Tomatoes, 20 kg at 2.00 | 40.00 | 2.00 | 1.00 | **37.00** |
| Farmer B | Peppers, 10 kg at 3.50 | 35.00 | 2.00 | 1.00 | **32.00** |
| Farmer C | Okra, 10 kg at 2.50 | 25.00 | 1.00 | 1.00 | **23.00** |
| Logistics | | | | | **3.00** (sum of the deductions) |
| Cooperative retained | | | | | **5.00** (sum of the fees) |
| **Total** | | **100.00** | | | **100.00** |

The 10.00 test order uses 2, 1 and 1 kilos with the fees and deductions scaled to match (A 3.70, B 3.20, C 2.30, logistics 0.30, retained 0.50).

## Security measures, briefly

Role guard on every page and route; same-site (CSRF) check on every request that changes data; per-route rate limits and login brute-force limits; strict input checks (unknown fields refused); signed session cookie backed by a server-side session so logout really ends it; security headers; provider tokens stored only encrypted; no logging in the app code; audit log with secrets redacted. These are checked by automated tests, see below. This is a prototype, not a security-audited product (see `docs/LIMITATIONS.md`).

## Running the tests and checks

```
npm test               # all automated tests (also builds the app once to test the browser bundle)
npm run typecheck      # TypeScript
npm run secrets:scan   # looks for secrets in tracked files and git history
npm run verify         # type-check, production build, all tests, secrets scan
```

Notable tests: `tests/access-matrix.test.ts` lists every page and API route against every kind of caller and fails if a route is added without being listed; `tests/hardening.test.ts` (login limits, sessions, headers, input checks); `tests/secrets-leak.test.ts` (no secrets in the audit log or output); `tests/bundle.test.ts` (no secrets in the browser bundle); the rest are in `lib/*.test.ts`. The tests use a fake provider (`lib/mock-provider.ts`). The real provider is only exercised by manual live runs.

## Folder guide

```
app/        pages and API routes             lib/        business logic and tests
db/         plain SQL migrations             scripts/    migrate, seed, reset, secrets scan, verify
tests/      cross-cutting tests              spike/      the original one-transfer proof (kept unchanged)
docs/       limitations, demo script, test evidence, verification checklist
```

The project began as a one-transfer proof on the test network, kept in `spike/` (`npm run check`, `npm run pay`).
