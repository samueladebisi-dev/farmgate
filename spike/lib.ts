// Shared helpers for check.ts and pay.ts.
// Nothing in here ever prints the private key, the key id's file, or any access token.
import "dotenv/config";
import {
  createAuthenticatedClient,
  createUnauthenticatedClient,
  OpenPaymentsClientError,
  type AuthenticatedClient,
  type WalletAddress,
} from "@interledger/open-payments";

// The test-wallet addresses we use. Farmers and logistics are USD, same account as the coop.
export const FARMERS_AND_LOGISTICS = [
  "https://ilp.interledger-test.dev/argus-farmer-a",
  "https://ilp.interledger-test.dev/argus-farmer-b",
  "https://ilp.interledger-test.dev/argus-farmer-c",
  "https://ilp.interledger-test.dev/argus-logistics",
];

/** Read a required setting from .env, or stop with a clear message. */
export function env(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing ${name} in .env`);
    process.exit(1);
  }
  return v;
}

/**
 * Build the authenticated client. The app's identity is the cooperative wallet address
 * plus the key (KEY_ID + private key file). Every request is signed with that key.
 */
export async function makeClient(): Promise<AuthenticatedClient> {
  return createAuthenticatedClient({
    walletAddressUrl: env("COOP_WALLET_ADDRESS"),
    privateKey: env("PRIVATE_KEY_PATH"), // path to the PEM file; the SDK reads it
    keyId: env("KEY_ID"),
    logLevel: "silent",
  });
}

/** Look up a wallet address document (public, no key needed). */
export async function resolveWallet(
  client: Pick<AuthenticatedClient, "walletAddress">,
  url: string,
): Promise<WalletAddress> {
  return client.walletAddress.get({ url });
}

/** Same lookup, but without a key (used by check.ts only if KEY_ID is still blank). */
export async function makePublicClient() {
  return createUnauthenticatedClient({ logLevel: "silent" });
}

/**
 * Money helper: "10.00" major units -> integer minor-unit string, using the real asset scale.
 * Pure integer/string maths, no floats. Example: ("10.00", 2) -> "1000"; ("10", 9) -> "10000000000".
 */
export function toMinorUnits(amount: string, scale: number): string {
  const [whole, frac = ""] = amount.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(frac) || frac.length > scale) {
    throw new Error(`Cannot represent "${amount}" with scale ${scale}`);
  }
  return (BigInt(whole) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, "0") || "0")).toString();
}

/** Show a minor-unit amount as a readable string, e.g. {value:"1000",assetScale:2,assetCode:"USD"} -> "10.00 USD". */
export function fmt(a: { value: string; assetCode: string; assetScale: number }): string {
  const v = BigInt(a.value);
  const d = 10n ** BigInt(a.assetScale);
  const frac = (v % d).toString().padStart(a.assetScale, "0");
  const shown = a.assetScale > 0 ? `${v / d}.${frac}` : `${v}`;
  return `${shown} ${a.assetCode}  (raw: ${a.value}, scale ${a.assetScale})`;
}

/** Print the real error from the provider (never tokens/keys) and stop. */
export function fail(step: string, err: unknown): never {
  console.error(`\n❌ FAILED at: ${step}`);
  if (err instanceof OpenPaymentsClientError) {
    console.error(`   message:     ${err.message}`);
    if (err.status) console.error(`   http status: ${err.status}`);
    if (err.code) console.error(`   code:        ${err.code}`);
    if (err.description) console.error(`   description: ${err.description}`);
    if (err.validationErrors?.length) console.error(`   validation:  ${JSON.stringify(err.validationErrors)}`);
  } else {
    console.error(`   ${err instanceof Error ? err.message : String(err)}`);
  }
  process.exit(1);
}
