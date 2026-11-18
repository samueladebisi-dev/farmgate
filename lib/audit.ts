// Append-only audit log writer. Metadata is redacted so secrets can never be stored.
import type { Db } from "./db";

// Any metadata key containing one of these words is replaced, at any depth.
const SENSITIVE = /(key|token|secret|password|passwd|nonce|authorization|cookie|jwk|private)/i;

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

export function audit(
  db: Db,
  e: { actor: string; action: string; entityType: string; entityId: string | number; metadata?: Record<string, unknown> },
): number {
  return Number(db.prepare("INSERT INTO audit_events (actor, action, entity_type, entity_id, metadata) VALUES (?,?,?,?,?)").run(
    e.actor,
    e.action,
    e.entityType,
    String(e.entityId),
    JSON.stringify(redact(e.metadata ?? {})),
  ).lastInsertRowid);
}
