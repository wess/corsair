-- App passwords: one credential per mail client, each revocable on its own.
--
-- A mailbox password typed into a phone, a laptop and a tablet is one secret in
-- three places, and losing any of them means changing it everywhere. Worse, for
-- an account with two-factor sign-in, that password still opens IMAP and SMTP
-- with no second factor, because those protocols have nowhere to put one. An app
-- password is a random secret the server chose, stored as a SHA-256 hash like
-- every other token here, and deleting its row stops it on every protocol at
-- once. Changing the mailbox password deliberately leaves them alone.
--
-- scopes is the set of protocols it opens (imap, pop3, smtp, jmap, dav, sieve),
-- kept as a jsonb array because the driver cannot bind a JS array to a Postgres
-- one.
CREATE TABLE app_passwords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_id UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes JSONB NOT NULL DEFAULT '["imap","pop3","smtp","jmap","dav","sieve"]'::jsonb,
  last_used_at TIMESTAMPTZ,
  last_used_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX app_passwords_address_idx ON app_passwords (address_id);

-- When set, the mailbox password itself is refused over the mail protocols and
-- only an app password opens them. The webmail and the panel are browser sign-ins
-- and keep using the real password (and, for the panel, its second factor).
ALTER TABLE addresses ADD COLUMN require_app_passwords BOOLEAN NOT NULL DEFAULT false;
