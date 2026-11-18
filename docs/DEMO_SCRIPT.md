# Five-minute live demo

Everything on screen is the **test network with play money**. Say that in the first ten seconds and leave the yellow banner visible.

## Before you go on stage (not part of the five minutes)

- [ ] `npm run verify` passed today.
- [ ] Wallet balances noted (buyer EUR, cooperative USD, farmers USD, logistics USD): see `docs/VERIFICATION_CHECKLIST.md` item 6.
- [ ] Three browser windows signed in: **operator**, **buyer**, and **farmer-a** (ideally the farmer on a phone). Wallet signed in in another tab.
- [ ] Payee wallets already verified once today (the Verify payees button is quick, but it is a live lookup).
- [ ] A **fresh demo order** is not created yet. You will build one live in beat 2 (use total 10.00 so the amounts are small).
- [ ] The **rehearsal order** where you declined a consent is open in a spare tab (needed in beat 6). If that order does not exist, do the decline test from `docs/VERIFICATION_CHECKLIST.md` item 1 first. Do not claim a rejected consent you have not recorded.
- [ ] `APP_BASE_URL` is correct for where you are demoing.

## The beats

### 0:00 to 0:30  The problem and the person
**Show:** nothing yet, or just the login page with the test-network banner.
**Say (notes):**
- "A buyer pays a farmers' cooperative once. The cooperative then has to pay several farmers and a transporter their shares, after a service fee and a transport deduction. Today that is often done by hand, and a farmer cannot easily see what they were paid or why."
- The person: the cooperative operator who has to get that split right and be able to prove it. (This is the situation we are designing for. It has not been validated with a real cooperative: say so if asked.)
- "This is a prototype on the Interledger test network. The money is play money. What is real is the Open Payments protocol: real quotes, real wallet consent, real provider statuses."
**Pass:** the audience knows who, what problem, and that it is a test network.

### 0:30 to 1:05  Build an order with itemised quantities and net allocations
**Show (operator):** Dashboard, **Create order**. Choose the buyer. Add three lines (for example Farmer A tomatoes, Farmer B peppers, Farmer C okra) with whole kilos and prices. Leave the default fee and deduction. Press **Preview allocation**. Then **Save order**.
**Say:**
- "Quantities in whole kilos, prices per kilo. Fee and logistics deduction are per farmer."
- Point at the preview table: "Each farmer's gross, fee, deduction and net. The cooperative keeps the fees, logistics gets the deductions, and the total equals what the buyer must pay. All whole cents, no rounding."
- "Nothing is saved until I press Save."
**Pass:** preview table appears, order saved as AWAITING_PAYMENT with a new PO number.
**If it fails:** use the dashboard button **Create fresh demo order** (10.00) and carry on.

### 1:05 to 1:45  Buyer consents, the app verifies the cooperative received it
**Show (buyer window):** the new order, **Get quote**, point at the three numbers (fixed USD amount for the cooperative, the buyer's wallet, the quoted EUR debit and expiry), **Authorize payment in wallet**, approve in the wallet, return to the app. Then the operator window: order status **RECEIVED**, "Provider received ... completed: yes".
**Say:**
- "The buyer pays in euros, the cooperative receives dollars. The quote is the provider's, not ours." (Read the EUR figure off the screen; do not quote a number from memory.)
- "The buyer approves in their own wallet. The app checks the return is genuine: right person, right order, not used before, hash verified."
- "The app does not take the buyer's word or the redirect's word. It asks the provider. Only when the provider says the cooperative's incoming payment is complete and exactly the right amount does the order become RECEIVED."
**Pass:** order shows RECEIVED with the confirmed amount, from the provider.
**Time risk:** the wallet pages are the slow part. If you are behind, skip reading the quote aloud.

### 1:45 to 2:15  Operator reviews and approves the split
**Show (operator):** **Verify payees** (if not already done), then **Review and approve the split**: each beneficiary's exact wallet address, net amount, total paid out, cooperative retained. Press **Approve and lock this split**.
**Say:**
- "Before any money leaves, the operator checks the exact wallet address of every recipient. The public name comes from the wallet and is not proof of identity, so we show the address."
- "Approving locks these amounts and addresses. If anyone changes an amount or a wallet afterwards, the approval is removed."
**Pass:** order shows APPROVED.

### 2:15 to 3:20  Cooperative wallet consent, real payouts, provider-derived status
**Show (operator):** **Start payouts** (four rows with quotes), then **Authorize all payouts in wallet**, approve in the wallet, return. Rows move to Confirmed. Show PROJECTED debit versus ACTUAL provider-confirmed debit. Order shows COMPLETED.
**Say:**
- "One payout per recipient. The app first checks the quotes add up to no more than what was received."
- "The cooperative's wallet approves. The app sends the payments one at a time and then reads each one back from the provider. It never writes 'paid' on its own."
- "Projected is what the quotes said; actual is what the provider confirms was sent."
- If the wallet needs one approval per payout (see `docs/TEST_EVIDENCE.md` for what was observed), say so plainly: "this provider allowed one payment per approval, so the app asks for each one", and approve them in turn. This takes longer. If you are short of time, show two and explain; do not skip the explanation.
**Pass:** each recipient row says Confirmed with provider ids; ACTUAL debit appears.
**Time risk:** this beat is the longest. Rehearse it.

### 3:20 to 3:55  The earlier genuine rejected consent, in the audit log
**Show (operator):** open the **rehearsal order** (the one where you declined). Scroll to **Audit**. Point at the line "Earlier consent cancelled in the wallet (not a failed transfer)".
**Say:**
- "This is not a third live redirect. This is the record from our rehearsal earlier, where I declined the approval in the wallet on purpose."
- "A declined approval is not a failed payment. Nothing was sent. The payout stayed waiting, nothing was marked failed, and the operator could simply try again, which is what happened next."
**Pass:** the audit line is visible with its time and the "cancelled, not failed" wording.
**Do not** present this as something that just happened live.

### 3:55 to 4:20  Farmer's phone receipt, plain words, role boundary
**Show (phone, farmer-a):** the big amount, "Paid", gross, fee, deduction, net, the short reference, and the **Text version** with Copy. Then, on the laptop, try the operator page while signed in as the farmer: it sends you back to the farmer page.
**Say:**
- "The farmer sees only their own payment, in plain words, with the arithmetic. The text version is for copying by hand: the app does not send SMS."
- "A farmer cannot see anyone else's amount, and cannot reach operator screens."
**Pass:** receipt matches the operator's row for Farmer A; redirect confirmed.

### 4:20 to 4:45  Next steps
**Say (pick the honest ones; do not claim traction):**
- "Talk to real cooperatives and farmers. Everything about how they split payments is an assumption we have not validated."
- "Cash-out and mobile-money delivery, SMS or other notices, refunds and disputes: none of that exists yet."
- "Key custody and operations for anything beyond a test network."
**Pass:** the audience hears what is not built.

### 4:45 to 5:00  Buffer
Questions, or catch up on whichever beat ran long. Do not add new material here.

## If something fails

The rule: **never change a status by hand, never edit the database during the demo, and never pass off a recording or an earlier result as live.** The app has no button that marks a payment paid. Keep it that way.

1. **A wallet page is slow or errors.** Say so. Wait ten seconds, try once. If it is still failing, move to the next beat that does not need the wallet (the audit log, the farmer receipt) and come back.
2. **The app shows an error notice.** Read it aloud: the message is the provider's reason. It is also in the audit list on the order page.
3. **A payment shows Submitted or "Needs checking".** That is the honest state. Press **Check status**. If the provider cannot be reached, say "the app will not guess, it shows what it last knew". This is a feature to point out, not hide.
4. **The provider refuses something (a quote expired, a grant limit).** Say what it is, use **Re-quote** or **New attempt** (these are the real operator actions), or move on.
5. **Nothing works at all.** Switch to the evidence: open `docs/TEST_EVIDENCE.md`, say clearly "this is the record of an earlier run, not live", read the provider resource ids and show the earlier order's audit log.
6. **Disclose.** If a beat is skipped or shortened, say so in one sentence. Do not fill silence with claims the product cannot back up.
