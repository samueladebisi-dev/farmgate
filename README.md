# Argus Payments

Cooperative payment workflow prototype. **TEST NETWORK, PLAY MONEY ONLY.**

The foundation (database, money engine, state machine, login) plus the real **buyer to cooperative payment** (quote, wallet consent, callback, reconciliation). Payouts to farmers are not built yet. The original payment proof lives in [spike/](spike/).

## Install

Requires Node 20+ (developed on Node 24).

```
npm install
```

## Set up .env

Copy the example and fill it in:

```
copy .env.example .env      (Windows)
cp .env.example .env        (Mac/Linux)
```

| Variable | What it is |
|---|---|
| `COOP_WALLET_ADDRESS`, `BUYER_WALLET_ADDRESS`, `KEY_ID`, `PRIVATE_KEY_PATH` | Used by the payment spike only (and the future payment module). `private.key` stays in the repo folder and is never committed. |
| `SESSION_SECRET` | Long random string that signs the login cookie. Generate one: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `APP_BASE_URL` | Public URL of this app, default `http://localhost:3000`. The wallet sends the buyer back to `APP_BASE_URL/api/payments/callback`. Always use `localhost` (not `127.0.0.1`) in the browser so the login cookie matches. |
| `DB_PATH` | SQLite file, default `./data/argus.db` |
| `ORDER_TOTAL_MAJOR` | Demo order total in USD, default `100.00`. Must be a multiple of `10.00` (so kilos stay whole). Use `10.00` for a small test. |
| `DEMO_*_PASSWORD` | Passwords for the demo users (play money only). |

`.env`, `private.key`, `*.db` and `node_modules` are git-ignored.

## Create and fill the database

```
npm run db:migrate    # applies db/migrations/*.sql
npm run db:seed       # users, wallets, order PO-0124 (skips if it already exists)
```

To change `ORDER_TOTAL_MAJOR` after seeding, or to start clean: `npm run db:reset` (deletes the database file, then migrates and seeds again).

## Run

```
npm run dev           # http://localhost:3000
npm test              # unit tests (vitest)
```

Log in with usernames `buyer`, `operator`, `farmer-a`, `farmer-b`, `farmer-c` and the matching passwords from your `.env`. Each role lands on its own page:

- `/operator` : order, items, allocation table, payout status
- `/buyer` : the buyer's own order
- `/farmer` : only that farmer's own amount and status, in plain words

> On Windows, run commands from a terminal whose path uses the same capital letters as the real folder (e.g. `C:\Users\HP\...`). A lower-case drive letter (`c:\...`, as Git Bash shows it) makes vitest fail with a confusing "Cannot read properties of undefined (reading 'config')" error.

## Live payment run

1. Set `ORDER_TOTAL_MAJOR=10.00` in `.env`, then `npm run db:reset` and `npm run dev`.
2. Log in as `buyer`, click **Get quote**, check the amounts, click **Authorize payment in wallet**, approve in the wallet, and you are sent back to the buyer page.
3. Log in as `operator` to see provider ids, the payment status and any exceptions. **Reconcile with provider** re-reads everything from the provider.

The wallet needs nothing registered for the redirect (the spike used a localhost callback the same way). Provider tokens are kept server-side only, encrypted in the database with a key derived from `SESSION_SECRET`.

## Layout

```
app/            Next.js pages and API routes (plain, unstyled-by-design)
lib/money.ts          integer-only money engine (+ tests)
lib/payout-state.ts   the six payout states, one transition function, wording (+ tests)
lib/access.ts         access-controlled reads (farmers only see their own data) (+ tests)
lib/auth.ts           role guard used by every page and API route
lib/payments.ts       quote, consent start, callback checks, reconciliation (+ tests with a mocked provider)
lib/provider.ts       the only file that talks to the Open Payments SDK
lib/reconcile-rules.ts  pure rules: exact, under, over, duplicate (+ tests)
db/migrations/        plain SQL migrations
scripts/              migrate, seed, reset
spike/                the proven payment spike (reference, unchanged)
```

## Rules baked in

- All money is an integer in minor units, with asset code and scale stored next to every amount.
- `audit_events` is append-only (database triggers block UPDATE and DELETE) and metadata is redacted: keys, tokens and secrets are never stored.
- There are exactly six payout states. "Cancelled" is not one: a rejected consent is `consent_outcome = REJECTED` on a payout still in `AWAITING_CONSENT`.

## Payment spike

`spike/check.ts` and `spike/pay.ts` are the original proof of one real buyer-to-cooperative transfer. Run from the repo root so `.env` and `private.key` are found: `npm run check`, `npm run pay`.
