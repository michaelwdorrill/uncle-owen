ALTER TABLE google_pending_connections ADD COLUMN revoke_after INTEGER NOT NULL DEFAULT 0;
ALTER TABLE google_pending_connections ADD COLUMN revoke_lease TEXT;
CREATE INDEX idx_pending_google_expiry ON google_pending_connections(expires_at, revoke_after);
