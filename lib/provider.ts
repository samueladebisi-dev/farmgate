// The ONLY place that talks to the Open Payments SDK. Call shapes are the ones proven in spike/pay.ts.
// Keys and tokens stay inside this server-side module; nothing here logs them.
import {
  createAuthenticatedClient,
  isFinalizedGrantWithAccessToken,
  isPendingGrant,
  OpenPaymentsClientError,
  type AuthenticatedClient,
} from "@interledger/open-payments";

// ---- Plain data shapes (so tests can mock the provider without the SDK) ----
export type ProviderAmount = { value: string; assetCode: string; assetScale: number };
export type WalletInfo = { id: string; assetCode: string; assetScale: number; authServer: string; resourceServer: string };
export type IncomingInfo = { id: string; completed: boolean; expiresAt?: string; incomingAmount?: ProviderAmount; receivedAmount: ProviderAmount };
export type QuoteInfo = { id: string; debitAmount: ProviderAmount; receiveAmount: ProviderAmount; expiresAt?: string };
export type OutgoingInfo = { id: string; failed: boolean; debitAmount: ProviderAmount; sentAmount: ProviderAmount; receiveAmount: ProviderAmount };
export type PendingGrantInfo = { redirectUrl: string; serverNonce: string; continueUri: string; continueToken: string };

/** The provider clearly said no (HTTP 4xx). Nothing was created. */
export class ProviderRejected extends Error {}
/** We cannot tell what happened (timeout, 5xx, garbled reply). Treat the outcome as UNKNOWN. */
export class ProviderUnclear extends Error {}

export interface PaymentProvider {
  getWallet(url: string): Promise<WalletInfo>;
  createIncomingPayment(a: { coop: WalletInfo; amount: ProviderAmount; expiresAt: string }): Promise<IncomingInfo>;
  getIncomingPayment(a: { coop: WalletInfo; id: string }): Promise<IncomingInfo>;
  completeIncomingPayment(a: { coop: WalletInfo; id: string }): Promise<IncomingInfo>;
  createQuote(a: { buyer: WalletInfo; incomingId: string }): Promise<QuoteInfo>;
  startOutgoingGrant(a: { buyer: WalletInfo; debit: ProviderAmount; finishUri: string; nonce: string }): Promise<PendingGrantInfo>;
  finishOutgoingGrant(a: { continueUri: string; continueToken: string; interactRef: string }): Promise<{ accessToken: string }>;
  createOutgoingPayment(a: { buyer: WalletInfo; accessToken: string; quoteId: string }): Promise<OutgoingInfo>;
  getOutgoingPayment(a: { buyer: WalletInfo; accessToken: string; id: string }): Promise<OutgoingInfo>;
}

/** Turn an SDK error into "clearly rejected" or "unclear". Only the message is kept, never request bodies/tokens. */
function classify(e: unknown): Error {
  if (e instanceof OpenPaymentsClientError) {
    const msg = `${e.message}${e.description ? `: ${e.description}` : ""}`.slice(0, 300);
    return e.status && e.status >= 400 && e.status < 500 ? new ProviderRejected(`${msg} (HTTP ${e.status})`) : new ProviderUnclear(msg);
  }
  return new ProviderUnclear(e instanceof Error ? e.message.slice(0, 300) : "Unknown provider error");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

export function createRealProvider(): PaymentProvider {
  // The app's identity: cooperative wallet address + key (same as the spike).
  let clientPromise: Promise<AuthenticatedClient> | null = null;
  const client = () =>
    (clientPromise ??= createAuthenticatedClient({
      walletAddressUrl: required("COOP_WALLET_ADDRESS"),
      privateKey: required("PRIVATE_KEY_PATH"),
      keyId: required("KEY_ID"),
      logLevel: "silent",
    }));

  /** Fresh non-interactive grant for incoming payments (create/read/complete), as in the spike. */
  async function incomingToken(coop: WalletInfo): Promise<string> {
    const c = await client();
    const g = await c.grant.request({ url: coop.authServer }, { access_token: { access: [{ type: "incoming-payment", actions: ["create", "read", "complete"] }] } });
    if (!isFinalizedGrantWithAccessToken(g)) throw new Error("Incoming-payment grant unexpectedly needs interaction");
    return g.access_token.value;
  }

  const toIncoming = (p: { id: string; completed: boolean; expiresAt?: string; incomingAmount?: ProviderAmount; receivedAmount: ProviderAmount }): IncomingInfo => ({
    id: p.id, completed: p.completed, expiresAt: p.expiresAt, incomingAmount: p.incomingAmount, receivedAmount: p.receivedAmount,
  });
  const toOutgoing = (p: OutgoingInfo): OutgoingInfo => ({
    id: p.id, failed: p.failed, debitAmount: p.debitAmount, sentAmount: p.sentAmount, receiveAmount: p.receiveAmount,
  });

  return {
    async getWallet(url) {
      const w = await (await client()).walletAddress.get({ url });
      return { id: w.id, assetCode: w.assetCode, assetScale: w.assetScale, authServer: w.authServer, resourceServer: w.resourceServer };
    },

    async createIncomingPayment({ coop, amount, expiresAt }) {
      const c = await client();
      const token = await incomingToken(coop);
      return toIncoming(await c.incomingPayment.create({ url: coop.resourceServer, accessToken: token }, { walletAddress: coop.id, incomingAmount: amount, expiresAt }));
    },

    async getIncomingPayment({ coop, id }) {
      const c = await client();
      return toIncoming(await c.incomingPayment.get({ url: id, accessToken: await incomingToken(coop) }));
    },

    async completeIncomingPayment({ coop, id }) {
      const c = await client();
      const p = await c.incomingPayment.complete({ url: id, accessToken: await incomingToken(coop) });
      return toIncoming({ ...p, receivedAmount: p.receivedAmount });
    },

    async createQuote({ buyer, incomingId }) {
      const c = await client();
      const g = await c.grant.request({ url: buyer.authServer }, { access_token: { access: [{ type: "quote", actions: ["create", "read"] }] } });
      if (!isFinalizedGrantWithAccessToken(g)) throw new Error("Quote grant unexpectedly needs interaction");
      const q = await c.quote.create({ url: buyer.resourceServer, accessToken: g.access_token.value }, { walletAddress: buyer.id, receiver: incomingId, method: "ilp" });
      return { id: q.id, debitAmount: q.debitAmount, receiveAmount: q.receiveAmount, expiresAt: q.expiresAt };
    },

    async startOutgoingGrant({ buyer, debit, finishUri, nonce }) {
      const c = await client();
      const g = await c.grant.request(
        { url: buyer.authServer },
        {
          access_token: { access: [{ type: "outgoing-payment", actions: ["create", "read"], identifier: buyer.id, limits: { debitAmount: debit } }] },
          interact: { start: ["redirect"], finish: { method: "redirect", uri: finishUri, nonce } },
        },
      );
      if (!isPendingGrant(g)) throw new Error("Expected a pending grant that needs interaction");
      return { redirectUrl: g.interact.redirect, serverNonce: g.interact.finish, continueUri: g.continue.uri, continueToken: g.continue.access_token.value };
    },

    async finishOutgoingGrant({ continueUri, continueToken, interactRef }) {
      const c = await client();
      try {
        let cont = await c.grant.continue({ url: continueUri, accessToken: continueToken }, { interact_ref: interactRef });
        for (let i = 0; i < 5 && !isFinalizedGrantWithAccessToken(cont); i++) {
          await sleep((cont.continue.wait ?? 2) * 1000);
          cont = await c.grant.continue({ url: cont.continue.uri, accessToken: cont.continue.access_token.value });
        }
        if (!isFinalizedGrantWithAccessToken(cont)) throw new Error("Grant was not finalised with an access token");
        return { accessToken: cont.access_token.value };
      } catch (e) {
        throw classify(e);
      }
    },

    async createOutgoingPayment({ buyer, accessToken, quoteId }) {
      const c = await client();
      try {
        return toOutgoing(await c.outgoingPayment.create({ url: buyer.resourceServer, accessToken }, { walletAddress: buyer.id, quoteId }));
      } catch (e) {
        throw classify(e); // rejected (4xx) vs unclear (timeout / 5xx / anything else)
      }
    },

    async getOutgoingPayment({ accessToken, id }) {
      const c = await client();
      return toOutgoing(await c.outgoingPayment.get({ url: id, accessToken }));
    },
  };
}

// One real provider per server process, created lazily so the app starts even before KEY_ID is set.
const g = globalThis as unknown as { __argusProvider?: PaymentProvider };
export function getProvider(): PaymentProvider {
  return (g.__argusProvider ??= createRealProvider());
}
