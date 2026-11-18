-- Cooperative side: payee verification, approval lock, payouts.
-- Tokens are stored only encrypted (*_enc), never audited.

-- Payee verification: who confirmed, and a fingerprint of what the provider said at that moment.
ALTER TABLE wallets ADD COLUMN verified_by INTEGER REFERENCES users(id);
ALTER TABLE wallets ADD COLUMN verified_fingerprint TEXT;
ALTER TABLE wallets ADD COLUMN verified_public_name TEXT;   -- name reported by the provider (not proof of identity)

-- If anything that identifies a wallet is edited, the verification is wiped automatically.
CREATE TRIGGER wallets_invalidate_verification
AFTER UPDATE OF canonical_url, asset_code, asset_scale, public_name ON wallets
BEGIN
  UPDATE wallets SET verified_at = NULL, verified_by = NULL, verified_fingerprint = NULL, verified_public_name = NULL WHERE id = NEW.id;
END;

-- Approval lock
ALTER TABLE orders ADD COLUMN approval_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN approval_fingerprint TEXT;    -- hash of every input the operator reviewed
ALTER TABLE orders ADD COLUMN approved_at TEXT;
ALTER TABLE allocations ADD COLUMN approved_at TEXT;

-- Earlier unused quotes on the buyer payment are marked expired (display label, not a payout state).
ALTER TABLE payment_resources ADD COLUMN expired_at TEXT;

-- Payout operations: denormalised copies so every row is self-explanatory.
ALTER TABLE payout_operations ADD COLUMN order_id INTEGER REFERENCES orders(id);
ALTER TABLE payout_operations ADD COLUMN recipient TEXT;
ALTER TABLE payout_operations ADD COLUMN net_minor INTEGER;
ALTER TABLE payout_operations ADD COLUMN asset_code TEXT;
ALTER TABLE payout_operations ADD COLUMN asset_scale INTEGER;

-- One attempt = one incoming payment + quote + (after consent) one outgoing payment.
ALTER TABLE payout_attempts ADD COLUMN attempt_uuid TEXT;
ALTER TABLE payout_attempts ADD COLUMN incoming_payment_id TEXT;
ALTER TABLE payout_attempts ADD COLUMN incoming_expires_at TEXT;
ALTER TABLE payout_attempts ADD COLUMN quote_expires_at TEXT;
ALTER TABLE payout_attempts ADD COLUMN quote_claimed_at TEXT;   -- compare-and-set so two requests cannot both create a quote
ALTER TABLE payout_attempts ADD COLUMN receive_minor INTEGER;
ALTER TABLE payout_attempts ADD COLUMN receive_asset TEXT;
ALTER TABLE payout_attempts ADD COLUMN receive_scale INTEGER;
ALTER TABLE payout_attempts ADD COLUMN received_minor INTEGER;  -- provider receivedAmount on the recipient's incoming payment
ALTER TABLE payout_attempts ADD COLUMN received_asset TEXT;
ALTER TABLE payout_attempts ADD COLUMN received_scale INTEGER;
ALTER TABLE payout_attempts ADD COLUMN incoming_completed INTEGER;
ALTER TABLE payout_attempts ADD COLUMN sent_minor INTEGER;      -- provider sentAmount on the outgoing payment
ALTER TABLE payout_attempts ADD COLUMN sent_asset TEXT;
ALTER TABLE payout_attempts ADD COLUMN sent_scale INTEGER;
ALTER TABLE payout_attempts ADD COLUMN outgoing_failed INTEGER;
ALTER TABLE payout_attempts ADD COLUMN grant_session_id INTEGER REFERENCES grant_sessions(id);
ALTER TABLE payout_attempts ADD COLUMN failure_message TEXT;
ALTER TABLE payout_attempts ADD COLUMN updated_at TEXT;
CREATE UNIQUE INDEX payout_attempts_uuid ON payout_attempts(attempt_uuid) WHERE attempt_uuid IS NOT NULL;

-- A consent can cover one payout or all of them.
ALTER TABLE grant_sessions ADD COLUMN access_token_enc TEXT;    -- outgoing-payment token after consent (encrypted)
ALTER TABLE grant_sessions ADD COLUMN scope TEXT;               -- 'ALL' or 'SINGLE' for payout consents
ALTER TABLE grant_sessions ADD COLUMN limit_minor INTEGER;      -- debit limit requested from the wallet
CREATE TABLE grant_session_operations (
  grant_session_id INTEGER NOT NULL REFERENCES grant_sessions(id),
  operation_id     INTEGER NOT NULL REFERENCES payout_operations(id),
  PRIMARY KEY (grant_session_id, operation_id)
);

CREATE INDEX payout_operations_order ON payout_operations(order_id);
