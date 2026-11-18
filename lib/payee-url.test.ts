import { describe, expect, it } from "vitest";
import { validatePayeeUrl, validateServerUrl } from "./payee-url";

describe("validatePayeeUrl", () => {
  it("accepts the test-network wallet host over https", () => {
    expect(validatePayeeUrl("https://ilp.interledger-test.dev/argus-farmer-a")).toEqual({ ok: true, url: "https://ilp.interledger-test.dev/argus-farmer-a" });
  });
  it.each([
    ["http scheme", "http://ilp.interledger-test.dev/argus-farmer-a"],
    ["localhost", "https://localhost/argus-farmer-a"],
    ["loopback IP", "https://127.0.0.1/argus-farmer-a"],
    ["private IP 10.x", "https://10.0.0.5/argus-farmer-a"],
    ["private IP 192.168.x", "https://192.168.1.10/argus-farmer-a"],
    ["link-local metadata IP", "https://169.254.169.254/latest"],
    ["IPv6 loopback", "https://[::1]/argus-farmer-a"],
    ["internal name", "https://wallet.internal/argus-farmer-a"],
    ["other host", "https://evil.example.com/argus-farmer-a"],
    ["look-alike subdomain", "https://ilp.interledger-test.dev.evil.com/argus-farmer-a"],
    ["credentials trick", "https://ilp.interledger-test.dev@evil.com/argus-farmer-a"],
    ["custom port", "https://ilp.interledger-test.dev:8443/argus-farmer-a"],
    ["query string", "https://ilp.interledger-test.dev/argus-farmer-a?x=1"],
    ["no path", "https://ilp.interledger-test.dev/"],
    ["dot-dot path", "https://ilp.interledger-test.dev/../admin"],
    ["not a url", "ilp.interledger-test.dev/argus-farmer-a"],
    ["other test host", "https://auth.interledger-test.dev/argus-farmer-a"],
  ])("refuses %s", (_n, url) => {
    expect(validatePayeeUrl(url).ok).toBe(false);
  });
});

describe("validateServerUrl", () => {
  it("accepts https servers on the test network, refuses everything else", () => {
    expect(validateServerUrl("https://auth.interledger-test.dev/abc").ok).toBe(true);
    expect(validateServerUrl("https://ilp.interledger-test.dev/abc").ok).toBe(true);
    expect(validateServerUrl("https://evil.example.com/abc").ok).toBe(false);
    expect(validateServerUrl("http://auth.interledger-test.dev/abc").ok).toBe(false);
    expect(validateServerUrl("https://10.0.0.1/abc").ok).toBe(false);
  });
});
