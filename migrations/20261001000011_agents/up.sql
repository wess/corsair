-- Agent email: a mailbox an AI agent can use to sign up for things on a
-- person's behalf and read the verification mail that comes back.
--
-- The mailbox itself is an ordinary `addresses` row with type 'agent' — it gets
-- folders, quota, and delivery like any other. This table is only the
-- credential. It is separate from `api_keys` on purpose: that table's tokens
-- send as a domain, and nothing should be one lookup away from confusing an
-- inbox-reading token with a sending one.
--
-- One address, one token. Stored as a SHA-256 hash like every other token here.
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address_id UUID NOT NULL UNIQUE REFERENCES addresses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX agents_user_idx ON agents (user_id);
