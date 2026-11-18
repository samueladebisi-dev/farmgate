# Argus Payments

Cooperative payment workflow prototype. **TEST NETWORK, PLAY MONEY ONLY.**

This stage is the app foundation: database, money engine, payout state machine, login and role-based pages. It makes **no payment calls**. The working payment proof lives in [spike/](spike/) and will become the payment module later.

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

## Layout

```
app/            Next.js pages and API routes (plain, unstyled-by-design)
lib/money.ts          integer-only money engine (+ tests)
lib/payout-state.ts   the six payout states, one transition function, wording (+ tests)
lib/access.ts         access-controlled reads (farmers only see their own data) (+ tests)
lib/auth.ts           role guard used by every page and API route
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
