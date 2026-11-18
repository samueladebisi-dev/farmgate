// npm run db:migrate - apply any new SQL files in db/migrations.
import "dotenv/config";
import { applyMigrations, dbPath, openDb } from "../lib/db.ts";

const db = openDb(dbPath());
const applied = applyMigrations(db);
console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database already up to date.");
