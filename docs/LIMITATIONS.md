# Limitations

This is a prototype. This page says plainly what it is not, so nobody has to find out later.

## Money and network
- **Play money only.** Everything runs on the Interledger **test network**. No real money, no real bank or mobile-money accounts, no compliance checks (identity, sanctions, limits).
- **One buyer currency and one cooperative currency.** The buyer's wallet is EUR and the cooperative's wallet is USD. The exchange rate and fees are whatever the provider quotes at the time; the app does not set or hedge them. Farmers and logistics are paid in USD (the same currency as the cooperative).
- **All wallets sit in one test-wallet account.** When the six wallet addresses were looked up, they all resolved to the same authorization and resource server. In particular the farmers and logistics wallets share the cooperative's wallet account on the test network. So the payouts are transfers between wallets that belong to the same account, and the wallet approval for the payouts is given by whoever controls that account. This does not show what happens with independent farmers who each have their own wallet provider. If the provider rejects or behaves oddly for this reason, the app shows the provider's message and records it in the audit log; it does not hide it.
- **Cash-out is out of scope.** Nothing here turns a wallet balance into cash or mobile money for a farmer.
- **Refunds, disputes and chargebacks are out of scope.** If a buyer overpays or underpays, the order is flagged for the operator and the extra money is never distributed; there is no automated refund. There is no way to reverse a completed payout.
- **One buyer wallet.** Every buyer user pays from the single demo buyer wallet. The wallet owner still has to approve each payment in the wallet.

## What has and has not been proven live
- Proven on the test network: a buyer-to-cooperative transfer with consent (see `docs/TEST_EVIDENCE.md`).
- **Not yet proven on the test network (at the time of writing):** payee verification against the real provider, the payouts to farmers and logistics, a declined consent on the cooperative wallet, and whether one wallet approval can fund all four payouts. The automated tests use a fake provider that behaves the way the Open Payments documents say a provider should; the real provider may differ. `docs/VERIFICATION_CHECKLIST.md` lists the live run to do.
- Observed provider behaviour (fill in after the live run):
  - One approval covered all four payouts: TO FILL AFTER LIVE RUN
  - Quoted debit for same-currency (USD to USD) payouts compared with the amount received: TO FILL AFTER LIVE RUN
  - Anything unexpected the provider did: TO FILL AFTER LIVE RUN

## Software limits
- **Single server, single file database.** SQLite in one file, no backups, no replication. Rate limits are kept in the server's memory and reset when it restarts, so they do not work across several servers.
- **Key custody.** The private key sits in a file on the server. There is no hardware key store, no key rotation, no separation between the people who run the server and the key. This is not suitable for real funds.
- **Not security-audited.** The measures in the README are tested by the automated tests, but there has been no independent review or penetration test. The Content Security Policy still allows inline scripts (a nonce-based policy would be stronger). There is no two-factor login. Demo passwords are simple by design.
- **The wallet callback is a cross-site GET** and so cannot use the same-site check the other routes use. It is protected by binding to the login session, a one-time consent reference, the nonce and hash check, and replay prevention. Unknown extra parameters on it are recorded in the audit log rather than refused, so that a genuine wallet return is not blocked.
- **Provider outages.** If the provider cannot be reached, the app shows the last status it read and says it could not check. It does not guess.
- **No SMS.** The receipt text under 160 characters is for manual copy. The app sends no SMS, email or push notification.
- **Plain screens.** The interface is deliberately plain and has had no design or accessibility review. It has been checked in tests, not on real phones yet (see the checklist).
- **No native app.** Web pages only.

## Assumptions about cooperative practice (NOT validated)
No cooperative, farmer, buyer or transporter has been interviewed or has used this. The design rests on assumptions that may be wrong:
- that a cooperative collects a single payment from a buyer and then splits it;
- that the cooperative's fee and the logistics deduction can be entered as a fixed amount per farmer for each order;
- that quantities are whole kilograms and prices are per kilogram;
- that one operator reviewing and approving the split matches how a cooperative decides;
- that a farmer would read a short text receipt, and would find it useful or trustworthy;
- that wallet-based payouts are something farmers could receive and use.

## What this project does not claim
- No customer, user, pilot, adoption, revenue or impact claims of any kind.
- No claim that it is compliant with any financial regulation.
- No performance figures. Anything measured is written down in `docs/TEST_EVIDENCE.md` with the date and the way it was measured, and the blanks there mean "not measured yet".
