-- Transactional sending over HTTP: a Resend-shaped API for applications that
-- send as a hosted domain without holding a mailbox credential.
--
-- It rides the same delivery queue as submission. What is new is the record of
-- what an application asked for (`emails`), the credential it asked with
-- (`api_keys`), the addresses it must stop mailing (`suppressions`), and the
-- replay protection its retries need (`idempotency_keys`).

-- Stored as a SHA-256 hash, like every other token here. The prefix is kept in
-- the clear so two keys can be told apart in a list without either being
-- recoverable.
CREATE TABLE api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Null means every domain the account owns. Only a sending_access key can be
  -- narrowed to one, matching Resend: a key that can read every email on the
  -- account is not usefully restricted by where it may send from.
  domain_id UUID REFERENCES domains(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'full_access',
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT api_keys_permission_chk CHECK (permission IN ('full_access', 'sending_access')),
  CONSTRAINT api_keys_scope_chk CHECK (domain_id IS NULL OR permission = 'sending_access')
);
CREATE INDEX api_keys_user_idx ON api_keys (user_id);

-- One row per API send. `from` and `to` are reserved words and @atlas/db emits
-- bare identifiers, hence the suffixed names.
CREATE TABLE emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id UUID REFERENCES domains(id) ON DELETE SET NULL,
  api_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL,
  message_id TEXT NOT NULL,
  from_address TEXT NOT NULL,
  to_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  bcc_addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  reply_to JSONB NOT NULL DEFAULT '[]'::jsonb,
  subject TEXT NOT NULL,
  html TEXT,
  text TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_event TEXT NOT NULL DEFAULT 'queued',
  scheduled_at TIMESTAMPTZ,
  size INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX emails_user_created_idx ON emails (user_id, created_at DESC, id DESC);

-- Ties a queue row back to the API send it belongs to. Null for everything the
-- queue carried before this existed: submission, forwards, bounces, notices.
ALTER TABLE deliveries ADD COLUMN email_id UUID REFERENCES emails(id) ON DELETE SET NULL;
CREATE INDEX deliveries_email_idx ON deliveries (email_id) WHERE email_id IS NOT NULL;

-- Addresses an account must not send to again. Per account, not per domain: a
-- mailbox that does not exist does not start existing for a different sender.
--
-- reason: bounce | complaint | manual
CREATE TABLE suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  reason TEXT NOT NULL,
  detail TEXT,
  -- No foreign key: the email that caused it is swept long before the
  -- suppression stops mattering.
  email_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppressions_user_email_idx ON suppressions (user_id, email);

CREATE TABLE idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  -- Null while the original request is still running. That is what lets a
  -- concurrent retry be told apart from a completed one.
  response_status INTEGER,
  response_body JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX idempotency_keys_user_key_idx ON idempotency_keys (user_id, key);
