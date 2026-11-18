-- Multiple orders, demo orders, and shareable receipt links.

-- Where an order came from (shown on the dashboard): SEED, OPERATOR (Create order form) or DEMO_RESET.
ALTER TABLE orders ADD COLUMN origin TEXT NOT NULL DEFAULT 'OPERATOR';
UPDATE orders SET origin = 'SEED' WHERE order_ref = 'PO-0124';

-- Receipt links: the token itself is NEVER stored, only its SHA-256 hash.
CREATE TABLE receipt_links (
  id             INTEGER PRIMARY KEY,
  token_hash     TEXT NOT NULL UNIQUE,
  order_id       INTEGER NOT NULL REFERENCES orders(id),
  allocation_id  INTEGER NOT NULL REFERENCES allocations(id),   -- exactly ONE recipient
  created_by     INTEGER NOT NULL REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at     TEXT NOT NULL,
  revoked_at     TEXT,
  revoked_by     INTEGER REFERENCES users(id),
  view_count     INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT
);
CREATE INDEX receipt_links_allocation ON receipt_links(allocation_id);
CREATE INDEX receipt_links_order ON receipt_links(order_id);
