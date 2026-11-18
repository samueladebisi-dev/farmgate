// A fake payment provider for tests. Behaves like the real one closely enough to exercise our rules:
// quotes expire, grants have limits, outgoing payments settle the matching incoming payment.
// NOT used by the app itself.
import {
  ProviderRejected, ProviderUnclear, type IncomingInfo, type OutgoingInfo, type PaymentProvider, type PendingGrantInfo, type ProviderAmount, type QuoteInfo, type WalletInfo,
} from "./provider";

export const SECRET_TOKEN = "SECRET-ACCESS-TOKEN-123";
export const SECRET_CONTINUE = "SECRET-CONTINUE-TOKEN-456";
export const BUYER_DEBIT = 920; // 9.20 EUR for a 10.00 USD receive: the "live" cross-currency quote

const BASE = "https://ilp.interledger-test.dev";
const KNOWN = ["da5d080e", "argus-coop", "argus-farmer-a", "argus-farmer-b", "argus-farmer-c", "argus-logistics"];

type QuoteRec = { incomingId: string; debit: ProviderAmount; receive: ProviderAmount; expiresAt: number };
type TokenRec = { limit: number; spent: number; count: number };

export class MockProvider implements PaymentProvider {
  clock: { t: number };
  incoming = new Map<string, IncomingInfo>();
  incomingWallet = new Map<string, string>(); // incoming payment id -> recipient wallet url
  outgoing = new Map<string, OutgoingInfo>();
  quotes = new Map<string, QuoteRec>();
  tokens = new Map<string, TokenRec>();
  grantLimits = new Map<string, number>(); // continue token -> limit
  n = 0;
  outgoingCalls = 0;
  incomingCreated = 0;
  quotesCreated = 0;
  outgoingMode: "ok" | "rejected" | "unclear" = "ok";
  /** Per recipient wallet URL: force an outgoing outcome for payouts paying that wallet. */
  outgoingModeFor = new Map<string, "rejected" | "unclear">();
  settleOnPay = true;
  completeCalls = 0;
  /** 'multi': a grant can fund several payments up to its limit. 'single': a second payment under one grant is refused. */
  grantMode: "multi" | "single" = "multi";
  /** Extra debit added to every same-currency quote (to test insufficient funds). */
  payoutFee = 0;
  walletOverrides = new Map<string, Partial<WalletInfo>>();
  lastGrant?: { finishUri: string; nonce: string; serverNonce: string; debit: ProviderAmount; authServer: string };
  grants: { finishUri: string; nonce: string; serverNonce: string; debit: ProviderAmount; authServer: string }[] = [];

  constructor(clock: { t: number }) {
    this.clock = clock;
  }

  async getWallet(url: string): Promise<WalletInfo> {
    const path = url.replace(`${BASE}/`, "");
    if (!url.startsWith(`${BASE}/`) || !KNOWN.includes(path)) throw new ProviderRejected(`Wallet not found (HTTP 404) for ${url}`);
    const eur = path === "da5d080e";
    const base: WalletInfo = { id: url, assetCode: eur ? "EUR" : "USD", assetScale: 2, authServer: "https://auth.interledger-test.dev/acct", resourceServer: "https://ilp.interledger-test.dev/acct", publicName: `Public ${path}` };
    return { ...base, ...(this.walletOverrides.get(url) ?? {}) };
  }
  async getWalletStrict(url: string) {
    return this.getWallet(url);
  }

  async createIncomingPayment({ coop, amount, expiresAt }: { coop: WalletInfo; amount: ProviderAmount; expiresAt: string }): Promise<IncomingInfo> {
    this.incomingCreated++;
    const id = `https://rs.test/incoming-payments/${++this.n}`;
    const info: IncomingInfo = { id, completed: false, expiresAt, incomingAmount: amount, receivedAmount: { ...amount, value: "0" } };
    this.incoming.set(id, info);
    this.incomingWallet.set(id, coop.id);
    return info;
  }
  async getIncomingPayment({ id }: { id: string }) {
    return { ...this.incoming.get(id)! };
  }
  async completeIncomingPayment({ id }: { id: string }) {
    this.completeCalls++;
    const i = this.incoming.get(id)!;
    i.completed = true;
    return { ...i };
  }

  async createQuote({ buyer, incomingId }: { buyer: WalletInfo; incomingId: string }): Promise<QuoteInfo> {
    this.quotesCreated++;
    const inc = this.incoming.get(incomingId)!;
    const receive = inc.incomingAmount!;
    const debit: ProviderAmount =
      buyer.assetCode === "EUR"
        ? { value: String(BUYER_DEBIT), assetCode: "EUR", assetScale: 2 }
        : { value: String(Number(receive.value) + this.payoutFee), assetCode: buyer.assetCode, assetScale: buyer.assetScale };
    const id = `https://rs.test/quotes/${++this.n}`;
    const expiresAt = this.clock.t + 5 * 60_000;
    this.quotes.set(id, { incomingId, debit, receive, expiresAt });
    return { id, debitAmount: debit, receiveAmount: receive, expiresAt: new Date(expiresAt).toISOString() };
  }

  async startOutgoingGrant(a: { buyer: WalletInfo; debit: ProviderAmount; finishUri: string; nonce: string }): Promise<PendingGrantInfo> {
    const g = { finishUri: a.finishUri, nonce: a.nonce, serverNonce: `server-nonce-${++this.n}`, debit: a.debit, authServer: a.buyer.authServer };
    this.lastGrant = g;
    this.grants.push(g);
    const continueToken = `${SECRET_CONTINUE}-${this.n}`;
    this.grantLimits.set(continueToken, Number(a.debit.value));
    return { redirectUrl: `https://wallet.test/consent/${this.n}`, serverNonce: g.serverNonce, continueUri: "https://auth.test/continue/1", continueToken };
  }
  async finishOutgoingGrant(a: { continueUri: string; continueToken: string; interactRef: string }) {
    const accessToken = `${SECRET_TOKEN}-${++this.n}`;
    this.tokens.set(accessToken, { limit: this.grantLimits.get(a.continueToken) ?? 0, spent: 0, count: 0 });
    return { accessToken };
  }

  async createOutgoingPayment({ buyer, accessToken, quoteId }: { buyer: WalletInfo; accessToken: string; quoteId: string }): Promise<OutgoingInfo> {
    this.outgoingCalls++;
    const q = this.quotes.get(quoteId);
    if (!q) throw new ProviderRejected("Unknown quote (HTTP 404)");
    const recipientUrl = this.incomingWallet.get(q.incomingId) ?? "";
    const forced = this.outgoingModeFor.get(recipientUrl) ?? (this.outgoingMode !== "ok" ? this.outgoingMode : null);
    if (forced === "rejected") throw new ProviderRejected("quote expired (HTTP 400)");
    if (forced === "unclear") throw new ProviderUnclear("timeout");
    if (this.clock.t > q.expiresAt) throw new ProviderRejected("Quote has expired (HTTP 400)");
    const tok = this.tokens.get(accessToken);
    if (!tok) throw new ProviderRejected("Invalid token (HTTP 401)");
    const debit = Number(q.debit.value);
    if (this.grantMode === "single" && tok.count >= 1) throw new ProviderRejected("Grant limit reached: this grant allows one payment (HTTP 403)");
    if (tok.spent + debit > tok.limit) throw new ProviderRejected("Grant limit exceeded (HTTP 403)");
    tok.spent += debit;
    tok.count++;
    void buyer;
    const o: OutgoingInfo = { id: `https://rs.test/outgoing-payments/${++this.n}`, failed: false, debitAmount: q.debit, sentAmount: q.debit, receiveAmount: q.receive };
    this.outgoing.set(o.id, o);
    if (this.settleOnPay) this.setReceived(q.incomingId, Number(q.receive.value), true);
    return o;
  }
  async getOutgoingPayment({ id }: { id: string }) {
    return { ...this.outgoing.get(id)! };
  }

  setReceived(incomingId: string, minor: number, completed: boolean) {
    const i = this.incoming.get(incomingId)!;
    i.receivedAmount = { value: String(minor), assetCode: i.incomingAmount?.assetCode ?? "USD", assetScale: 2 };
    i.completed = completed;
  }
  latestIncomingId() {
    return [...this.incoming.keys()].at(-1)!;
  }
}
