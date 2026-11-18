// npm run verify - one command that must pass before you demo or share the repo:
//   1. type-check  2. production build  3. all tests (including the bundle test, which reuses the build)  4. secrets scan
// Each step's output is shown only if it fails. Exit code 1 if any step fails.
import { spawnSync } from "node:child_process";

type Step = { name: string; cmd: string[]; env?: Record<string, string> };
const node = process.execPath;
const steps: Step[] = [
  { name: "Type-check", cmd: [node, "node_modules/typescript/bin/tsc", "--noEmit"] },
  { name: "Production build", cmd: [node, "node_modules/next/dist/bin/next", "build"] },
  { name: "All tests (incl. bundle test)", cmd: [node, "node_modules/vitest/vitest.mjs", "run"], env: { BUNDLE_TEST_PREBUILT: "1" } },
  { name: "Secrets scan", cmd: [node, "node_modules/tsx/dist/cli.mjs", "scripts/secrets-scan.ts"] },
];

const results: { name: string; ok: boolean; seconds: number; summary: string }[] = [];
for (const s of steps) {
  const t0 = Date.now();
  console.log(`\n=== ${s.name} ===`);
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), { encoding: "utf8", env: { ...process.env, ...s.env }, maxBuffer: 1 << 28 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ok = r.status === 0;
  const lines = out.split(/\r?\n/).filter((l) => l.trim());
  const pick = (re: RegExp) => lines.filter((l) => re.test(l)).map((l) => l.trim()).join(" | ");
  const summary = s.name.startsWith("All tests") ? pick(/Test Files|Tests\s/) : s.name === "Secrets scan" ? pick(/^(OK|FAILED|Scanned)/) : ok ? "ok" : "failed";
  if (!ok) console.log(out.split(/\r?\n/).slice(-80).join("\n"));
  else console.log(summary || "ok");
  results.push({ name: s.name, ok, seconds: Math.round((Date.now() - t0) / 100) / 10, summary });
  if (!ok) break; // later steps depend on earlier ones
}

console.log("\n=== Result ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.seconds}s)`);
const skipped = steps.slice(results.length).map((s) => s.name);
for (const n of skipped) console.log(`SKIP  ${n}`);
const allOk = results.length === steps.length && results.every((r) => r.ok);
console.log(allOk ? "\nVERIFY PASSED" : "\nVERIFY FAILED");
process.exit(allOk ? 0 : 1);
