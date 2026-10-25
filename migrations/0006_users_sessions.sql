-- Username + password login with 30-day sessions (replaces typing APP_TOKEN in the browser).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,     -- pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The browser holds a random token in an HttpOnly cookie; only its SHA-256
-- is stored here, so a leaked database can't be replayed as a login.
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,             -- hex SHA-256 of the cookie token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  renewed_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE INDEX idx_sessions_user ON sessions (user_id);
