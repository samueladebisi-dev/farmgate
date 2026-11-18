// Strict allow-list for payee wallet addresses. Runs BEFORE any network request.
// Only the Interledger test-network wallet host over https is allowed. Everything else is refused:
// other hosts, http, localhost, private/internal IPs, credentials in the URL, odd ports, query strings.

export const ALLOWED_WALLET_HOST = "ilp.interledger-test.dev";
/** Auth/resource servers the wallet document points to must also live on the test network. */
export const ALLOWED_SERVER_SUFFIX = ".interledger-test.dev";

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function validatePayeeUrl(raw: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  // Look at the RAW path too: URL parsing silently collapses ".." and decodes some tricks.
  const rawPath = raw.replace(/^[a-z]+:\/\/[^/]*/i, "");
  if (/(^|\/)\.{1,2}(\/|$)|%2e|%2f|%5c|\\/i.test(rawPath)) return { ok: false, reason: "Wallet path is unsafe" };
  if (u.protocol !== "https:") return { ok: false, reason: "Only https is allowed" };
  if (u.username || u.password) return { ok: false, reason: "Credentials in the URL are not allowed" };
  if (u.port) return { ok: false, reason: "Custom ports are not allowed" };
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return { ok: false, reason: "Local or internal hosts are not allowed" };
  if (IPV4.test(host) || host.startsWith("[") || host.includes(":")) return { ok: false, reason: "IP addresses are not allowed" };
  if (host !== ALLOWED_WALLET_HOST) return { ok: false, reason: `Host must be exactly ${ALLOWED_WALLET_HOST}` };
  if (u.search || u.hash) return { ok: false, reason: "Query strings and fragments are not allowed" };
  if (u.pathname.length < 2 || u.pathname.split("/").some((s) => s === ".." || s === ".")) return { ok: false, reason: "Wallet path is missing or unsafe" };
  return { ok: true, url: `${u.origin}${u.pathname}`.replace(/\/$/, "") };
}

/** The auth and resource server URLs inside the wallet document must be https and on the test network too. */
export function validateServerUrl(raw: string): UrlCheck {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: "Not a valid URL" };
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password || u.port) return { ok: false, reason: "Server URL must be plain https" };
  if (IPV4.test(host) || host.includes(":") || !(host === ALLOWED_SERVER_SUFFIX.slice(1) || host.endsWith(ALLOWED_SERVER_SUFFIX))) {
    return { ok: false, reason: `Server host ${host} is not on the test network` };
  }
  return { ok: true, url: raw };
}
