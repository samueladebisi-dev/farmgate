-- Real buyer -> cooperative payment wiring.
-- Provider tokens are stored ONLY encrypted (AES-GCM, key derived from SESSION_SECRET), only in the *_enc columns,
-- and are never sent to the browser or written to audit_events.

ALTER TABLE orders ADD COLUMN exception TEXT;              -- e.g. UNDERPAYMENT / OVERPAYMENT / DUPLICATE_PAYMENT / ASSET_MISMATCH
ALTER TABLE orders ADD COLUMN exception_detail TEXT;
ALTER TABLE orders ADD COLUMN confirmed_incoming_id TEXT;  -- the one provider incoming payment that triggered RECEIVED

ALTER TABLE payment_resources ADD COLUMN buyer_wallet_id INTEGER REFERENCES wallets(id);
ALTER TABLE payment_resources ADD COLUMN quote_expires_at TEXT;
ALTER TABLE payment_resources ADD COLUMN incoming_expires_at TEXT;
ALTER TABLE payment_resources ADD COLUMN incoming_completed INTEGER;      -- 0/1 as reported by the provider
ALTER TABLE payment_resources ADD COLUMN received_minor INTEGER;         -- provider receivedAmount on the incoming payment
ALTER TABLE payment_resources ADD COLUMN received_asset TEXT;
ALTER TABLE payment_resources ADD COLUMN received_scale INTEGER;
ALTER TABLE payment_resources ADD COLUMN sent_minor INTEGER;             -- provider sentAmount on the outgoing payment
ALTER TABLE payment_resources ADD COLUMN sent_asset TEXT;
ALTER TABLE payment_resources ADD COLUMN sent_scale INTEGER;
ALTER TABLE payment_resources ADD COLUMN outgoing_failed INTEGER;        -- 0/1 as reported by the provider
ALTER TABLE payment_resources ADD COLUMN consent_outcome TEXT CHECK (consent_outcome IS NULL OR consent_outcome = 'REJECTED');
ALTER TABLE payment_resources ADD COLUMN outgoing_token_enc TEXT;
ALTER TABLE payment_resources ADD COLUMN updated_at TEXT;

ALTER TABLE grant_sessions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'BUYER_PAYMENT';
ALTER TABLE grant_sessions ADD COLUMN payment_resource_id INTEGER REFERENCES payment_resources(id);
ALTER TABLE grant_sessions ADD COLUMN server_nonce TEXT;      -- nonce returned by the auth server (needed for the hash check)
ALTER TABLE grant_sessions ADD COLUMN grant_endpoint TEXT;    -- the auth server URL used for the grant request (needed for the hash check)
ALTER TABLE grant_sessions ADD COLUMN continue_uri TEXT;
ALTER TABLE grant_sessions ADD COLUMN continue_token_enc TEXT;
ALTER TABLE grant_sessions ADD COLUMN used_at TEXT;           -- set once, in a transaction: replay prevention

CREATE UNIQUE INDEX grant_sessions_reference ON grant_sessions(grant_reference) WHERE grant_reference IS NOT NULL;
CREATE INDEX payment_resources_order ON payment_resources(order_id, direction, id);
