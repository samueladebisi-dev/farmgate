// check.ts - resolve every wallet address and print its REAL asset details.
// Run: npx tsx check.ts
import { env, fail, FARMERS_AND_LOGISTICS, makeClient, makePublicClient, resolveWallet } from "./lib.ts";

const wallets: [string, string][] = [
  ["buyer", env("BUYER_WALLET_ADDRESS")],
  ["cooperative", env("COOP_WALLET_ADDRESS")],
  ["farmer A", FARMERS_AND_LOGISTICS[0]],
  ["farmer B", FARMERS_AND_LOGISTICS[1]],
  ["farmer C", FARMERS_AND_LOGISTICS[2]],
  ["logistics", FARMERS_AND_LOGISTICS[3]],
];

// Create the authenticated client. If KEY_ID is still blank we can't sign yet, but looking up
// wallet addresses is public, so fall back to an unauthenticated client and say so.
let client;
if (process.env.KEY_ID?.trim()) {
  try {
    client = await makeClient();
    console.log("Authenticated client created (identity = cooperative wallet address + key).\n");
  } catch (e) {
    fail("creating the authenticated client", e);
  }
} else {
  console.log("⚠ KEY_ID is blank in .env, so no authenticated client yet.");
  console.log("  Wallet lookups are public, so continuing with an unauthenticated client.\n");
  client = await makePublicClient();
}

for (const [label, url] of wallets) {
  try {
    const w = await resolveWallet(client, url);
    console.log(`${label}  ${url}`);
    console.log(`   assetCode:      ${w.assetCode}`);
    console.log(`   assetScale:     ${w.assetScale}`);
    console.log(`   authServer:     ${w.authServer}`);
    console.log(`   resourceServer: ${w.resourceServer}\n`);
  } catch (e) {
    fail(`resolving ${label} (${url})`, e);
  }
}
