# Manual verification checklist

The automated tests (`npm run verify`) cannot do these. Do them in this order. Write each result where it says. Nothing here has been done yet unless you have filled it in.

Setup first: `npm run db:migrate`, `npm run verify` passes, wallet signed in, `.env` has your real `KEY_ID` and `private.key`.

## 1. Live payout run, with a decline first and then an approval

**Do:**
1. Note all wallet balances first (item 6).
2. In `.env` set `ORDER_TOTAL_MAJOR=10.00` only if you are re-seeding. Otherwise use the dashboard button **Create fresh demo order** with total 10.00. Your existing `PO-0124` (10.00, already RECEIVED) can be used as it is.
3. Operator: **Verify payees** and read the four exact addresses. **Review and approve the split**, **Approve and lock**.
4. **Start payouts.** Check four quotes appear and PROJECTED is about 9.50 USD for a 10.00 order.
5. **Authorize all payouts in wallet**, and in the wallet **decline**.
6. Look at the order page. Then **Authorize all payouts in wallet** again and **approve**.
7. Press **Check status** on any row not yet Confirmed.

**Pass looks like:**
- After the decline: all four rows say "Awaiting consent" with "Earlier consent cancelled in the wallet. Not a failed transfer." and nothing says Failed. The Audit list has a "cancelled" line.
- After the approval: each row shows Confirmed with incoming, quote and outgoing ids; ACTUAL debit appears; the order is COMPLETED.
- You know whether one approval covered all four payouts (the Audit "Payout submission summary" line says `grantDidNotCoverAll`). If it did not, the app asks for one approval per recipient: finish them one by one.

**Write the result in:** `docs/TEST_EVIDENCE.md` rows "Payouts live" and "Declined consent live". Also fill the "Observed provider behaviour" lines in `docs/LIMITATIONS.md`. If anything failed or looked odd, write exactly what the screen and the audit list said.

## 2. Farmer receipt on a real phone

**Do:** the phone must reach the app. A plain `http://192.168...` address will NOT keep a login: when `APP_BASE_URL` is not localhost the session cookie is marked Secure and a phone will not store it over plain http. Use an `https` address (for example a tunnelling tool) and set `APP_BASE_URL` to it, then `npm run build` and `npm start`. Sign in as `farmer-a` on the phone. Open the receipt, press **Copy text**, paste it into a notes app.

**Pass looks like:** big amount and plain-word status readable without zooming; only Farmer A's numbers; the pasted text is under 160 characters and has no emoji; the farmer cannot open `/operator`.

**Write the result in:** `docs/TEST_EVIDENCE.md`, row "Farmer receipt on a real phone" (phone model, browser, date, pass or what was wrong).

## 3. Receipt link and QR scanned from a phone

**Do:** operator, order page, **Create receipt link** for one recipient. Copy the link and scan the QR code with a phone camera. This page needs no login, so it works over plain http on the same Wi-Fi if `APP_BASE_URL` is the laptop's address, but the link only works from a phone if `APP_BASE_URL` is an address the phone can reach (the default `localhost` will not work from a phone). Then press **Revoke** and open the link again.

**Pass looks like:** the phone shows exactly one recipient's receipt, no wallet address, no phone number. After Revoke (and after 24 hours at most) it says the link is not available. The QR opens the same link.

**Write the result in:** `docs/TEST_EVIDENCE.md`, row "Receipt link and QR on a phone".

## 4. 320 px width check

**Do:** in a desktop browser open developer tools, set the device width to 320 px. Visit: login, buyer page, farmer page, a receipt link page, and the operator order page.

**Pass looks like:** no sideways scrolling on login, farmer and receipt pages; all text readable; buttons big enough to tap. Write down any page that scrolls sideways or cuts text off (the operator pages are tables and may scroll: note it).

**Write the result in:** `docs/TEST_EVIDENCE.md`, row "320 px width", one line per page.

## 5. Slow-network load check, with measured numbers

**Do:** use the production build (`npm run build`, `npm start`), not `npm run dev`. In browser developer tools, Network tab, choose a throttling profile (write down which one), disable cache, and load the farmer page and a receipt link page three times each. Record what the Network tab reports.

**Decide first, and write down before measuring,** what you will call acceptable. The pages have no images and no external requests, so the figures are what they are; this app has not been measured yet and no target is claimed.

| Page | Throttle profile | Run | DOMContentLoaded | Load | Transferred | Notes |
|---|---|---|---|---|---|---|
| Farmer page | _write it_ | 1 | | | | |
| Farmer page | | 2 | | | | |
| Farmer page | | 3 | | | | |
| Receipt link | | 1 | | | | |
| Receipt link | | 2 | | | | |
| Receipt link | | 3 | | | | |

**Pass looks like:** you have the numbers written down, your acceptable limit written down before them, and an honest yes or no.

**Write the result in:** this table, copied into `docs/TEST_EVIDENCE.md` row "Slow-network load".

## 6. Wallet balances before and after

**Do:** in the test wallet, note the balances of the buyer (EUR), cooperative (USD), Farmer A, B, C (USD) and logistics (USD) before the live runs, and again after. Write down the date and time of each reading.

**Pass looks like:** the changes match the provider-reported amounts in the app. For a 10.00 order, if payout debits equal the amounts received, you would expect: buyer down by the quoted EUR debit; cooperative up by 10.00 then down by 9.50 (net +0.50); farmers up by their nets (3.70, 3.20, 2.30); logistics up by 0.30. The provider's actual figures are what count. Because the wallets share one account (see `docs/LIMITATIONS.md`), say how the wallet app shows per-address balances.

**Write the result in:** `docs/TEST_EVIDENCE.md`, row "Wallet balances before and after".

## 7. Copy the provider ids into the evidence

**Do:** from the operator order page use the **Copy** buttons (or the audit list) to copy each incoming payment, quote and outgoing payment id for the buyer payment and for each of the four payouts. Paste them into the blanks marked `TO FILL AFTER LIVE RUN` in `docs/TEST_EVIDENCE.md`. Also confirm the two ids you were given earlier (see the note in that file about where they come from).

**Pass looks like:** no `TO FILL AFTER LIVE RUN` left in the live rows, or each one left blank on purpose with a reason.

**Write the result in:** `docs/TEST_EVIDENCE.md` itself.

## 8. Nothing sensitive in git before the repo is public or shared

**Do:**
1. Commit your work. The scan only looks at files git tracks or would track, plus history.
2. Run `npm run secrets:scan`. It must print `OK: no secrets found.`
3. Run `git status` and confirm `.env`, `private.key` and `data/` are not listed.
4. Run `git log --all --stat` and look for any file you would not want to show.
5. Check the commit **author name and email** in `git log`: they are part of the history and become public. Change them (or use a no-reply email) before publishing if you want them private. Rewriting history needs care; ask before doing it.
6. Skim `docs/` and `README.md` for anything personal.

**Pass looks like:** scan prints OK, none of the three items appears in git, you are happy with the author details.

**Write the result in:** `docs/TEST_EVIDENCE.md`, row "No secrets in git" (date and the scan's last line).

## 9. Rehearse the demo with a timer

**Do:** run `docs/DEMO_SCRIPT.md` start to finish with a stopwatch, with a fresh order and real wallet clicks. Write down the time each beat actually started.

| Beat | Planned start | Actual start | Notes |
|---|---|---|---|
| Problem and persona | 0:00 | | |
| Build an order | 0:30 | | |
| Buyer consent and verification | 1:05 | | |
| Review and approve | 1:45 | | |
| Payouts | 2:15 | | |
| Earlier rejected consent in audit | 3:20 | | |
| Farmer receipt | 3:55 | | |
| Next steps | 4:20 | | |
| Buffer | 4:45 | | |

**Pass looks like:** you finish inside five minutes at least once without skipping a beat, and you know which beat to shorten if the wallet is slow (the payouts beat is the risk).

**Write the result in:** the table above, and one line in `docs/TEST_EVIDENCE.md` row "Demo rehearsal".
