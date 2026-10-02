-- Webmail sessions with a server-side record, like the panel's.
--
-- A webmail session used to be only a signed token naming an address. Nothing on
-- the server said whether it was still wanted, so logging out cleared a cookie
-- and left the token valid until it expired, a password change could not end it,
-- and anyone who learned JWT_SECRET could mint one for any address from nothing
-- but its id. With a row, the token has to name a live session: forging one means
-- guessing a random id, logout and credential changes revoke it, and the
-- address's deletion takes its sessions with it.
CREATE TABLE mail_sessions (
  id TEXT PRIMARY KEY,
  address_id UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX mail_sessions_address_idx ON mail_sessions (address_id) WHERE revoked_at IS NULL;
CREATE INDEX mail_sessions_expires_idx ON mail_sessions (expires_at);
