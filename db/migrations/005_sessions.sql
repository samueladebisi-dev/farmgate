-- Server-side sessions: the signed cookie only carries a session id. Logging out revokes the row,
-- so a copied cookie stops working immediately (a signed cookie alone cannot be taken back).
CREATE TABLE sessions (
  sid        TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
