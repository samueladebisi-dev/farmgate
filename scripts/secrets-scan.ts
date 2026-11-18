// npm run secrets:scan
// Looks for secrets in (a) every file git tracks or would track (not ignored) and (b) the whole git history.
// Finds: private key headers, base64-encoded private keys, long random-looking tokens, the contents of private.key,
// and any value copied from your local .env. Also checks that private.key, .env and database files were never committed.
// It NEVER prints a secret: only the file, line, rule and the length of what it found. Exit code 1 if anything is found.
// A line can be marked as a known false positive by adding the text  secrets-scan:allow  on it.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";

type Finding = { where: string; rule: string; detail: string };
const findings: Finding[] = [];
const ALLOW = "secrets-scan:allow";

// ---------------------------------------------------------------------------
// What to look for
// ---------------------------------------------------------------------------
/** .env settings that are not secrets (public addresses, paths, defaults). Everything else in .env counts as secret. */
const NON_SECRET_ENV = new Set(["COOP_WALLET_ADDRESS", "BUYER_WALLET_ADDRESS", "PRIVATE_KEY_PATH", "DB_PATH", "APP_BASE_URL", "ORDER_TOTAL_MAJOR"]);

function parseEnv(file: string): [string, string][] {
  if (!fs.existsSync(file)) return [];
  const out: [string, string][] = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out.push([m[1], m[2].replace(/^["']|["']$/g, "")]);
  }
  return out;
}

const envSecrets = parseEnv(".env").filter(([k, v]) => !NON_SECRET_ENV.has(k) && v.length >= 8);
const keyBody = fs.existsSync("private.key") ? fs.readFileSync("private.key", "utf8").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "") : "";

const HEADER = new RegExp("-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----");
const BASE64_KEYS: [string, RegExp][] = [
  ["base64 Ed25519 private key", /MC4CAQAwBQYDK2VwBCIE[A-Za-z0-9+/]{20,}/],
  ["base64 RSA private key", /MIIE[vwxyz][A-Za-z0-9+/]{40,}/],
  ["base64 EC private key", /MHcCAQEE[A-Za-z0-9+/]{20,}/],
];
const TOKEN = /[A-Za-z0-9+/_=-]{40,}/g;

function entropy(s: string): number {
  const f = new Map<string, number>();
  for (const c of s) f.set(c, (f.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of f.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}
const looksRandom = (t: string) => entropy(t) >= 4.2 && /[A-Za-z]/.test(t) && /\d/.test(t) && !/^https?:/.test(t) && !t.includes("//");

/** Scan one line of text. `where` is a label like "path:12". */
function scanLine(line: string, where: string) {
  if (line.includes(ALLOW)) return;
  if (HEADER.test(line)) findings.push({ where, rule: "private key header", detail: "PEM header found" });
  for (const [name, re] of BASE64_KEYS) if (re.test(line)) findings.push({ where, rule: name, detail: "key-like base64" });
  for (const m of line.match(TOKEN) ?? []) if (looksRandom(m)) findings.push({ where, rule: "long random token", detail: `length ${m.length}` });
  if (keyBody.length >= 20 && (line.includes(keyBody) || line.includes(keyBody.slice(0, 40)))) findings.push({ where, rule: "contents of private.key", detail: "key body found" });
  for (const [k, v] of envSecrets) if (line.includes(v)) findings.push({ where, rule: `value copied from .env (${k})`, detail: `length ${v.length}` });
}

// ---------------------------------------------------------------------------
// 1. Files in the working tree that git tracks or would track
// ---------------------------------------------------------------------------
const SKIP_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const FORBIDDEN_PATH = /(^|\/)(\.env(\.(?!example$)[^/]*)?|private\.key|[^/]*\.(key|pem|p12|pfx)|[^/]*\.(db|sqlite3?)(-wal|-shm)?)$/;

const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\0").filter(Boolean);
let filesScanned = 0;
for (const f of files) {
  if (FORBIDDEN_PATH.test(f)) findings.push({ where: f, rule: "forbidden file would be committed", detail: "key, .env or database file is not ignored" });
  if (SKIP_FILES.test(f) || !fs.existsSync(f)) continue;
  const st = fs.statSync(f);
  if (!st.isFile() || st.size > 1_500_000) continue;
  const buf = fs.readFileSync(f);
  if (buf.subarray(0, 8000).includes(0)) continue; // binary
  filesScanned++;
  buf.toString("utf8").split(/\r?\n/).forEach((line, i) => scanLine(line, `${f}:${i + 1}`));
}

// ---------------------------------------------------------------------------
// 2. File names that must never appear anywhere in history
// ---------------------------------------------------------------------------
const hasCommits = (() => {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
let commits = 0;
if (hasCommits) {
  commits = Number(execFileSync("git", ["rev-list", "--all", "--count"], { encoding: "utf8" }).trim());
  const names = new Set(execFileSync("git", ["log", "--all", "--name-only", "--pretty=format:", "--no-renames"], { encoding: "utf8", maxBuffer: 1 << 28 }).split("\n").filter(Boolean));
  for (const n of names) if (FORBIDDEN_PATH.test(n)) findings.push({ where: `history:${n}`, rule: "forbidden file in git history", detail: "key, .env or database file was committed at some point" });
}

// ---------------------------------------------------------------------------
// 3. Added lines in history
// ---------------------------------------------------------------------------
async function scanHistory() {
  if (!hasCommits) return 0;
  const p = spawn("git", ["log", "--all", "-p", "-U0", "--no-color", "--no-ext-diff", "--no-renames", "--pretty=format:commit %h"], { stdio: ["ignore", "pipe", "inherit"] });
  const rl = readline.createInterface({ input: p.stdout });
  let commit = "";
  let file = "";
  let n = 0;
  for await (const line of rl) {
    if (line.startsWith("commit ")) commit = line.slice(7);
    else if (line.startsWith("+++ b/")) file = line.slice(6);
    else if (line.startsWith("+++ ")) file = "";
    else if (line.startsWith("+") && file && !SKIP_FILES.test(file)) {
      n++;
      scanLine(line.slice(1), `history ${commit} ${file}`);
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// 4. Report
// ---------------------------------------------------------------------------
const histLines = await scanHistory();

const ignoredOk = (p: string) => {
  try {
    execFileSync("git", ["check-ignore", "-q", p], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
for (const p of ["private.key", ".env", "data/argus.db"]) if (!ignoredOk(p)) findings.push({ where: p, rule: "not git-ignored", detail: "add it to .gitignore" });

console.log(`Scanned ${filesScanned} files (tracked or not ignored) and ${histLines} added lines across ${commits} commit(s).`);
console.log(`Looked for: private key headers, base64 keys, long random tokens, the private.key contents, ${envSecrets.length} secret value(s) from .env, and forbidden files.`);
console.log(`private.key / .env / database files in history or the commit set: ${findings.some((f) => /forbidden file|not git-ignored/.test(f.rule)) ? "FOUND (see below)" : "none"}`);
const seen = new Set<string>();
const unique = findings.filter((f) => {
  const k = `${f.where}|${f.rule}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
if (unique.length) {
  console.log(`\nFAILED: ${unique.length} finding(s). Secrets are not printed.`);
  for (const f of unique) console.log(`  ${f.where}  [${f.rule}]  ${f.detail}`);
  process.exit(1);
}
console.log("\nOK: no secrets found.");
