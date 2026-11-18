// npm run db:reset - delete the local database file, then migrate and seed again.
// (The audit log cannot be emptied from inside SQL by design, so reset removes the file.)
import "dotenv/config";
import fs from "node:fs";
import { dbPath } from "../lib/db.ts";

const file = dbPath();
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(file + suffix, { force: true });
console.log(`Removed ${file}`);
const { execSync } = await import("node:child_process");
execSync("npm run db:migrate && npm run db:seed", { stdio: "inherit" });
