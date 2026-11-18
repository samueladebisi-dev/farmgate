// pay.ts - ONE real Open Payments transfer: buyer (EUR) -> cooperative (USD), with interactive consent.
// Run: npx tsx pay.ts
// Nothing is faked: any failure prints the real error and stops.
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { isFinalizedGrantWithAccessToken, isPendingGrant } from "@interledger/open-payments";
import { env, fail, fmt, makeClient, resolveWallet, toMinorUnits } from "./lib.ts";

const CALLBACK_PORT = 3344;
const CALLBACK_URL = `http://localhost:${CALLBACK_PORT}/callback`;
const RECEIVE_AMOUNT_MAJOR = "10.00"; // fixed amount the cooperative must receive, in USD

/**
 * Official hash check (openpayments.dev "Hash verification"):
 * SHA-256 of  clientNonce \n serverNonce \n interact_ref \n grantEndpointUri , base64-encoded.
 * The docs call for base64 "with no padding" while their JS example uses plain base64, so we
 * compare in a normalised form (no '=' padding, url-safe characters mapped to standard ones).
 */
function verifyInteractionHash(p: {
  clientNonce: string;
  serverNonce: string;
  interactRef: string;
  grantEndpoint: string;
  receivedHash: string;
}): boolean {
  const base = `${p.clientNonce}\n${p.serverNonce}\n${p.interactRef}\n${p.grantEndpoint}`;
  const norm = (s: string) => s.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const expected = createHash("sha256").update(base).digest("base64");
  return norm(expected) === norm(p.receivedHash);
}

/** Start a tiny local server and wait until the auth server sends the user back to /callback. */
function waitForCallback(): Promise<URLSearchParams> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${CALLBACK_PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2>Consent received. You can close this tab and go back to the terminal.</h2>");
      clearTimeout(timer);
      server.close();
      resolve(url.searchParams);
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out after 10 minutes waiting for the consent callback"));
    }, 10 * 60 * 1000);
    server.on("error", reject);
    server.listen(CALLBACK_PORT);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Setup: client + the two wallet addresses
// ---------------------------------------------------------------------------
let step = "creating the authenticated client";
try {
  const client = await makeClient();

  step = "resolving wallet addresses";
  const buyer = await resolveWallet(client, env("BUYER_WALLET_ADDRESS"));
  const coop = await resolveWallet(client, env("COOP_WALLET_ADDRESS"));
  console.log(`Buyer: ${buyer.id} (${buyer.assetCode}, scale ${buyer.assetScale})`);
  console.log(`Coop:  ${coop.id} (${coop.assetCode}, scale ${coop.assetScale})\n`);

  // -------------------------------------------------------------------------
  // 1. Incoming payment at the cooperative: fixed receive amount of 10.00 USD
  // -------------------------------------------------------------------------
  step = "1a. requesting incoming-payment grant from the cooperative's auth server";
  const incomingGrant = await client.grant.request(
    { url: coop.authServer },
    {
      access_token: {
        access: [{ type: "incoming-payment", actions: ["create", "read", "complete"] }],
      },
    },
  );
  if (!isFinalizedGrantWithAccessToken(incomingGrant)) {
    throw new Error("Incoming-payment grant unexpectedly needs interaction");
  }
  const incomingToken = incomingGrant.access_token.value;

  step = "1b. creating the incoming payment";
  const receiveAmount = {
    value: toMinorUnits(RECEIVE_AMOUNT_MAJOR, coop.assetScale), // integer minor units
    assetCode: coop.assetCode,
    assetScale: coop.assetScale,
  };
  const incoming = await client.incomingPayment.create(
    { url: coop.resourceServer, accessToken: incomingToken },
    {
      walletAddress: coop.id,
      incomingAmount: receiveAmount,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // valid for 1 hour
    },
  );
  console.log(`1. Incoming payment created: ${incoming.id}`);
  console.log(`   incomingAmount: ${fmt(incoming.incomingAmount!)}\n`);

  // -------------------------------------------------------------------------
  // 2. Quote on the buyer's side (buyer EUR -> incoming payment USD)
  // -------------------------------------------------------------------------
  step = "2a. requesting quote grant from the buyer's auth server";
  const quoteGrant = await client.grant.request(
    { url: buyer.authServer },
    { access_token: { access: [{ type: "quote", actions: ["create", "read"] }] } },
  );
  if (!isFinalizedGrantWithAccessToken(quoteGrant)) {
    throw new Error("Quote grant unexpectedly needs interaction");
  }

  step = "2b. creating the quote";
  const quote = await client.quote.create(
    { url: buyer.resourceServer, accessToken: quoteGrant.access_token.value },
    { walletAddress: buyer.id, receiver: incoming.id, method: "ilp" },
  );
  console.log(`2. Quote created: ${quote.id}`);
  console.log(`   debit (buyer pays): ${fmt(quote.debitAmount)}`);
  console.log(`   receive (coop gets): ${fmt(quote.receiveAmount)}`);
  console.log(`   expires: ${quote.expiresAt ?? "(no expiry given)"}\n`);

  // -------------------------------------------------------------------------
  // 3. Outgoing-payment grant WITH user consent (redirect)
  // -------------------------------------------------------------------------
  step = "3a. requesting interactive outgoing-payment grant";
  const clientNonce = randomUUID(); // random value we send; used later to verify the callback
  const outgoingGrant = await client.grant.request(
    { url: buyer.authServer },
    {
      access_token: {
        access: [
          {
            type: "outgoing-payment",
            actions: ["create", "read"],
            identifier: buyer.id,
            // Cap the grant at exactly what the quote says the buyer will pay.
            limits: { debitAmount: quote.debitAmount },
          },
        ],
      },
      interact: {
        start: ["redirect"],
        finish: { method: "redirect", uri: CALLBACK_URL, nonce: clientNonce },
      },
    },
  );
  if (!isPendingGrant(outgoingGrant)) {
    throw new Error("Expected a pending grant that needs interaction, but got a finished grant");
  }

  // Start the local server BEFORE showing the URL so we cannot miss the redirect.
  const callback = waitForCallback();
  console.log("3. Open this URL in your browser and approve the payment:\n");
  console.log(`   ${outgoingGrant.interact.redirect}\n`);
  console.log(`Waiting for the redirect back to ${CALLBACK_URL} ...`);

  step = "3b. waiting for the consent callback";
  const params = await callback;
  const interactRef = params.get("interact_ref");
  const hash = params.get("hash");
  if (!interactRef || !hash) {
    // e.g. the user rejected: the auth server returns an error/result instead of interact_ref
    throw new Error(`Callback had no interact_ref/hash. Params received: ${[...params.keys()].join(", ") || "(none)"}` +
      (params.get("result") ? ` result=${params.get("result")}` : ""));
  }

  step = "3c. verifying the interaction hash";
  const ok = verifyInteractionHash({
    clientNonce,
    serverNonce: outgoingGrant.interact.finish, // nonce the auth server returned
    interactRef,
    grantEndpoint: buyer.authServer, // the grant endpoint URI we used for the initial request
    receivedHash: hash,
  });
  if (!ok) throw new Error("Interaction hash did NOT match - refusing to continue (possible tampering)");
  console.log("   Interaction hash verified ✔\n");

  step = "3d. continuing the grant";
  let continued = await client.grant.continue(
    { url: outgoingGrant.continue.uri, accessToken: outgoingGrant.continue.access_token.value },
    { interact_ref: interactRef },
  );
  // If the server asks us to wait, retry a few times (it normally answers straight away).
  for (let i = 0; i < 5 && !isFinalizedGrantWithAccessToken(continued); i++) {
    await sleep((continued.continue.wait ?? 2) * 1000);
    continued = await client.grant.continue({
      url: continued.continue.uri,
      accessToken: continued.continue.access_token.value,
    });
  }
  if (!isFinalizedGrantWithAccessToken(continued)) {
    throw new Error("Grant was not finalised with an access token");
  }
  const outgoingToken = continued.access_token.value;

  step = "3e. creating the outgoing payment";
  const outgoing = await client.outgoingPayment.create(
    { url: buyer.resourceServer, accessToken: outgoingToken },
    { walletAddress: buyer.id, quoteId: quote.id },
  );

  // -------------------------------------------------------------------------
  // 4. Report + re-fetch both payments from the provider for their real status
  // -------------------------------------------------------------------------
  console.log("4. IDs");
  console.log(`   incoming payment: ${incoming.id}`);
  console.log(`   quote:            ${quote.id}`);
  console.log(`   outgoing payment: ${outgoing.id}\n`);

  await sleep(3000); // give the ILP payment a moment to settle

  step = "4a. fetching the outgoing payment again";
  const outNow = await client.outgoingPayment.get({ url: outgoing.id, accessToken: outgoingToken });
  console.log("Outgoing payment (from provider):");
  console.log(`   failed:        ${outNow.failed}`);
  console.log(`   debitAmount:   ${fmt(outNow.debitAmount)}`);
  console.log(`   sentAmount:    ${fmt(outNow.sentAmount)}`);
  console.log(`   receiveAmount: ${fmt(outNow.receiveAmount)}\n`);

  step = "4b. fetching the incoming payment again";
  const inNow = await client.incomingPayment.get({ url: incoming.id, accessToken: incomingToken });
  console.log("Incoming payment (from provider):");
  console.log(`   completed:      ${inNow.completed}`);
  console.log(`   incomingAmount: ${inNow.incomingAmount ? fmt(inNow.incomingAmount) : "(none)"}`);
  console.log(`   receivedAmount: ${fmt(inNow.receivedAmount)}`);
} catch (e) {
  fail(step, e);
}
