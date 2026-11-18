// SQLite connection + plain-SQL migration runner (db/migrations/*.sql, applied in filename order).
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type Db = Database.Database;

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

/** Open a database file (or ":memory:") with the safety settings we always want. */
export function openDb(file: string): Db {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  if (file !== ":memory:") db.pragma("journal_mode = WAL");
  return db;
}

/** Apply every migration file that has not been applied yet. Returns the names it applied. */
export function applyMigrations(db: Db, dir = MIGRATIONS_DIR): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const done = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((r) => (r as { name: string }).name));
  const applied: string[] = [];
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name) VALUES (?)").run(file);
    })();
    applied.push(file);
  }
  return applied;
}

export function dbPath(): string {
  return process.env.DB_PATH?.trim() || "./data/argus.db";
}

// One shared connection per server process (kept on globalThis so Next dev reloads reuse it).
const g = globalThis as unknown as { __argusDb?: Db };

export function getDb(): Db {
  if (!g.__argusDb) g.__argusDb = openDb(dbPath());
  return g.__argusDb;
}
