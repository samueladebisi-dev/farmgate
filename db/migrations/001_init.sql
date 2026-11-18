-- Initial schema. All money is INTEGER minor units with asset_code + asset_scale beside it.
-- Owners of wallets / items / allocations are text keys: 'buyer', 'cooperative', 'logistics',
-- 'farmer-a', 'farmer-b', 'farmer-c'. A farmer user is linked to their key via users.linked_farmer_id.

CREATE TABLE users (
  id               INTEGER PRIMARY KEY,
  username         TEXT NOT NULL UNIQUE,
  role             TEXT NOT NULL CHECK (role IN ('buyer','operator','farmer')),
  name             TEXT NOT NULL,
  password_hash    TEXT NOT NULL,
  linked_farmer_id TEXT,
  CHECK ((role = 'farmer') = (linked_farmer_id IS NOT NULL))
);

CREATE TABLE wallets (
  id            INTEGER PRIMARY KEY,
  owner         TEXT NOT NULL,
  canonical_url TEXT NOT NULL UNIQUE,
  asset_code    TEXT NOT NULL,
  asset_scale   INTEGER NOT NULL CHECK (asset_scale >= 0),
  public_name   TEXT NOT NULL,
  verified_at   TEXT
);

CREATE TABLE orders (
  id                       INTEGER PRIMARY KEY,
  order_ref                TEXT NOT NULL UNIQUE,
  buyer_user_id            INTEGER NOT NULL REFERENCES users(id),
  buyer_wallet_id          INTEGER NOT NULL REFERENCES wallets(id),
  cooperative_wallet_id    INTEGER NOT NULL REFERENCES wallets(id),
  expected_receive_minor   INTEGER NOT NULL CHECK (expected_receive_minor > 0),
  confirmed_received_minor INTEGER CHECK (confirmed_received_minor IS NULL OR confirmed_received_minor >= 0),
  asset_code               TEXT NOT NULL,
  asset_scale              INTEGER NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'AWAITING_PAYMENT'
                           CHECK (status IN ('AWAITING_PAYMENT','RECEIVED','APPROVED','COMPLETED')),
  version                  INTEGER NOT NULL DEFAULT 1,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE order_items (
  id                 INTEGER PRIMARY KEY,
  order_id           INTEGER NOT NULL REFERENCES orders(id),
  farmer_id          TEXT NOT NULL,
  produce            TEXT NOT NULL,
  kg                 INTEGER NOT NULL CHECK (kg > 0),
  price_minor_per_kg INTEGER NOT NULL CHECK (price_minor_per_kg > 0),
  gross_minor        INTEGER NOT NULL,
  asset_code         TEXT NOT NULL,
  asset_scale        INTEGER NOT NULL,
  CHECK (gross_minor = kg * price_minor_per_kg)
);

CREATE TABLE allocations (
  id               INTEGER PRIMARY KEY,
  order_id         INTEGER NOT NULL REFERENCES orders(id),
  recipient        TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('farmer','logistics','cooperative')),
  gross_minor      INTEGER NOT NULL,
  fee_minor        INTEGER NOT NULL,
  deduction_minor  INTEGER NOT NULL,
  net_minor        INTEGER NOT NULL,
  asset_code       TEXT NOT NULL,
  asset_scale      INTEGER NOT NULL,
  approval_version INTEGER NOT NULL DEFAULT 0,
  approved_by      INTEGER REFERENCES users(id),
  UNIQUE (order_id, recipient),
  CHECK (net_minor = gross_minor - fee_minor - deduction_minor)
);

CREATE TABLE payment_resources (
  id                    INTEGER PRIMARY KEY,
  order_id              INTEGER NOT NULL REFERENCES orders(id),
  direction             TEXT NOT NULL CHECK (direction IN ('INBOUND','OUTBOUND')),
  incoming_payment_id   TEXT,
  quote_id              TEXT,
  outgoing_payment_id   TEXT,
  quote_debit_minor     INTEGER,
  quote_debit_asset     TEXT,
  quote_debit_scale     INTEGER,
  receive_minor         INTEGER,
  receive_asset         TEXT,
  receive_scale         INTEGER,
  state                 TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE payout_operations (
  id               INTEGER PRIMARY KEY,
  allocation_id    INTEGER NOT NULL REFERENCES allocations(id),
  approval_version INTEGER NOT NULL,
  transfer_purpose TEXT NOT NULL CHECK (transfer_purpose IN ('FARMER_PAYOUT','LOGISTICS_PAYOUT')),
  idempotency_key  TEXT NOT NULL UNIQUE,
  state            TEXT NOT NULL DEFAULT 'CREATED'
                   CHECK (state IN ('CREATED','AWAITING_CONSENT','SUBMITTED','UNKNOWN','FAILED','CONFIRMED')),
  -- "Cancelled" is not a state: a rejected consent is only recorded here, while still AWAITING_CONSENT.
  consent_outcome  TEXT CHECK (consent_outcome IS NULL OR consent_outcome = 'REJECTED'),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (allocation_id, approval_version, transfer_purpose),
  CHECK (consent_outcome IS NULL OR state = 'AWAITING_CONSENT')
);

CREATE TABLE payout_attempts (
  id                  INTEGER PRIMARY KEY,
  operation_id        INTEGER NOT NULL REFERENCES payout_operations(id),
  attempt_number      INTEGER NOT NULL CHECK (attempt_number >= 1),
  quote_id            TEXT,
  outgoing_payment_id TEXT,
  quote_debit_minor   INTEGER,
  quote_debit_asset   TEXT,
  quote_debit_scale   INTEGER,
  outcome             TEXT CHECK (outcome IS NULL OR outcome IN ('PENDING','SUCCESS','FAILED','UNKNOWN')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (operation_id, attempt_number)
);

CREATE TABLE grant_sessions (
  id                   INTEGER PRIMARY KEY,
  initiator_session_id TEXT NOT NULL,
  wallet_id            INTEGER NOT NULL REFERENCES wallets(id),
  order_id             INTEGER NOT NULL REFERENCES orders(id),
  nonce                TEXT NOT NULL,
  grant_reference      TEXT,
  expires_at           TEXT NOT NULL,
  outcome              TEXT CHECK (outcome IS NULL OR outcome IN ('GRANTED','REJECTED','EXPIRED','ERROR')),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Append-only audit log. Metadata must be redacted by the writer: never keys, tokens or secrets.
CREATE TABLE audit_events (
  id          INTEGER PRIMARY KEY,
  at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}'
);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END;
