// Builds the app for production and checks what the BROWSER would receive:
//  - the client bundle contains none of your .env values and not the words PRIVATE KEY,
//  - a real production server answers with the security headers and keeps strangers out.
// `npm run verify` builds once and sets BUNDLE_TEST_PREBUILT=1 so this test reuses that build.
// Run on its own (`npm test`), it builds into .next-bundle-test so it never disturbs a running dev server.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, openDb } from "../lib/db";

const prebuilt = process.env.BUNDLE_TEST_PREBUILT === "1";
const dist = prebuilt ? ".next" : ".next-bundle-test";
const nextBin = path.join("node_modules", "next", "dist", "bin", "next");
const PORT = 3197;
const base = `http://127.0.0.1:${PORT}`;

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
function envValues(): [string, string][] {
  const out: [string, string][] = [];
  for (const f of [".env", ".env.example"]) {
    if (!fs.existsSync(f)) continue;
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m && m[2].replace(/^["']|["']$/g, "").length >= 8) out.push([m[1], m[2].replace(/^["']|["']$/g, "")]);
    }
  }
  return out;
}

let server: ChildProcess | undefined;
let tmp = "";

beforeAll(async () => {
  if (!prebuilt) {
    fs.rmSync(dist, { recursive: true, force: true });
    execFileSync(process.execPath, [nextBin, "build"], { env: { ...process.env, NODE_ENV: "production", NEXT_DIST_DIR: dist }, stdio: "pipe", timeout: 540_000 });
  }
  expect(fs.existsSync(path.join(dist, "static")), `no build found in ${dist}`).toBe(true);

  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "argus-bundle-"));
  const db = openDb(path.join(tmp, "empty.db")); // real tables, no data
  applyMigrations(db);
  db.close();
  server = spawn(process.execPath, [nextBin, "start", "-p", String(PORT), "-H", "127.0.0.1"], {
    env: { ...process.env, NODE_ENV: "production", NEXT_DIST_DIR: dist, DB_PATH: path.join(tmp, "empty.db"), SESSION_SECRET: "bundle-test-session-secret-0123456789" },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/login`)).status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("production server did not start");
}, 600_000);

afterAll(async () => {
  // Wait for the server to really stop (on Windows it keeps the database file locked until then).
  if (server && server.exitCode === null) {
    const exited = new Promise((r) => server!.once("exit", r));
    server.kill();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  }
  const rm = (p: string) => {
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch {
      /* leftover temp files are harmless */
    }
  };
  if (tmp) rm(tmp);
  if (!prebuilt) rm(dist);
});

describe("client bundle", () => {
  // Everything the browser can download: the static folder and any pre-rendered HTML.
  const clientFiles = () => [...walk(path.join(dist, "static")), ...walk(path.join(dist, "server", "app")).filter((f) => f.endsWith(".html"))];

  it("contains files to check", () => {
    const files = clientFiles().filter((f) => /\.(js|css|html|json|map)$/.test(f));
    expect(files.length).toBeGreaterThan(5);
  });

  it("contains none of the .env values", () => {
    const values = envValues();
    expect(values.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const f of clientFiles()) {
      const text = fs.readFileSync(f, "utf8");
      for (const [k, v] of values) if (text.includes(v)) hits.push(`${k} in ${f}`);
    }
    expect(hits).toEqual([]);
  });

  it("does not contain the words PRIVATE KEY, the private key file, or the names of secret settings", () => {
    const keyFile = fs.existsSync("private.key") ? fs.readFileSync("private.key", "utf8").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "") : "";
    const hits: string[] = [];
    for (const f of clientFiles()) {
      const text = fs.readFileSync(f, "utf8");
      if (/PRIVATE[ _]KEY/i.test(text)) hits.push(`PRIVATE KEY in ${f}`);
      if (/SESSION_SECRET|PRIVATE_KEY_PATH|DEMO_[A-Z]+_PASSWORD/.test(text)) hits.push(`secret setting name in ${f}`);
      if (keyFile.length > 20 && text.includes(keyFile.slice(0, 40))) hits.push(`key body in ${f}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("production server", () => {
  it("sends the security headers on pages (and no X-Powered-By), without unsafe-eval", async () => {
    const r = await fetch(`${base}/login`);
    const csp = r.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("unsafe-eval");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
    expect(r.headers.get("permissions-policy")).toMatch(/camera=\(\)/);
    expect(r.headers.get("x-powered-by")).toBeNull();
    expect(r.headers.get("set-cookie")).toBeNull(); // visiting does not create a session
  });

  it("the public receipt route is never cached, never indexed, sends no referrer, and treats unknown tokens as 404", async () => {
    const r = await fetch(`${base}/r/${"A".repeat(43)}`);
    expect(r.status).toBe(404);
    expect(r.headers.get("cache-control")).toMatch(/no-store/);
    expect(r.headers.get("x-robots-tag")).toMatch(/noindex/);
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
  });

  it("keeps strangers out: pages redirect to login, APIs say 401, cross-site posts are refused", async () => {
    for (const p of ["/operator", "/buyer", "/farmer", "/operator/orders/1"]) {
      const r = await fetch(`${base}${p}`, { redirect: "manual" });
      expect([307, 308], p).toContain(r.status);
      expect(new URL(r.headers.get("location")!, base).pathname).toBe("/login");
    }
    expect((await fetch(`${base}/api/orders`)).status).toBe(401);
    expect((await fetch(`${base}/api/orders`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect((await fetch(`${base}/api/payouts/1/retry`, { method: "POST", headers: { origin: "https://evil.example" } })).status).toBe(401);
  });
});
