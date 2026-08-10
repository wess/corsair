CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- accounts --

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  name TEXT,
  notifications_email TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  theme TEXT NOT NULL DEFAULT 'dark',
  totp_secret TEXT,
  totp_enabled BOOLEAN NOT NULL DEFAULT false,
  backup_codes JSONB,
  notification_prefs JSONB,
  referral_code TEXT NOT NULL UNIQUE,
  referred_by UUID REFERENCES users(id) ON DELETE SET NULL,
  is_owner BOOLEAN NOT NULL DEFAULT false,
  email_verified_at TIMESTAMPTZ,
  terminated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The first account to be created owns the instance. The partial index is what
-- actually enforces it; signup races on this constraint and the loser retries
-- as a non-owner.
CREATE UNIQUE INDEX users_single_owner_idx ON users (is_owner) WHERE is_owner;

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  address_id UUID,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tokens_expiry_idx ON tokens (expires_at) WHERE used_at IS NULL;

CREATE TABLE referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  referred_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rewarded_at TIMESTAMPTZ,
  reward_months INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (referred_id)
);
CREATE INDEX referrals_referrer_idx ON referrals (referrer_id);

-- ----------------------------------------------------------------- billing --

CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  storage_bytes BIGINT NOT NULL,
  daily_in INTEGER NOT NULL,
  daily_out INTEGER NOT NULL,
  monthly_cents INTEGER NOT NULL DEFAULT 0,
  yearly_cents INTEGER NOT NULL DEFAULT 0,
  max_domains INTEGER,
  max_addresses INTEGER,
  features JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_trial BOOLEAN NOT NULL DEFAULT false,
  visible BOOLEAN NOT NULL DEFAULT true,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES plans(id),
  status TEXT NOT NULL DEFAULT 'trialing',
  interval TEXT NOT NULL DEFAULT 'yearly',
  current_period_start TIMESTAMPTZ NOT NULL DEFAULT now(),
  current_period_end TIMESTAMPTZ NOT NULL,
  cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
  cancelled_at TIMESTAMPTZ,
  credit_months INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  provider_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- One live subscription per account. Upgrades mutate the row rather than
-- inserting a second one, so a partial unique index is enough.
CREATE UNIQUE INDEX subscriptions_active_idx
  ON subscriptions (user_id) WHERE status IN ('trialing', 'active', 'past_due');

CREATE TABLE transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  status TEXT NOT NULL DEFAULT 'paid',
  provider TEXT,
  provider_ref TEXT,
  invoice_number TEXT,
  transaction_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transactions_user_idx ON transactions (user_id, transaction_date DESC);

CREATE TABLE payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brand TEXT NOT NULL,
  last4 TEXT NOT NULL,
  exp_month INTEGER,
  exp_year INTEGER,
  is_default BOOLEAN NOT NULL DEFAULT false,
  provider TEXT,
  provider_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_methods_user_idx ON payment_methods (user_id);
CREATE UNIQUE INDEX payment_methods_default_idx
  ON payment_methods (user_id) WHERE is_default;

CREATE TABLE tax_ids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  country TEXT,
  business_name TEXT,
  address_line TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tax_ids_user_idx ON tax_ids (user_id);

-- ----------------------------------------------------------------- domains --

CREATE TABLE domains (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  verification_token TEXT NOT NULL,
  fallback_domain_id UUID REFERENCES domains(id) ON DELETE SET NULL,
  self_service_enabled BOOLEAN NOT NULL DEFAULT false,
  dmarc_policy TEXT NOT NULL DEFAULT 'quarantine',
  bytes_used BIGINT NOT NULL DEFAULT 0,
  verified_at TIMESTAMPTZ,
  last_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- A domain can only be hosted once across the whole instance: two accounts
-- claiming the same name would make routing ambiguous.
CREATE UNIQUE INDEX domains_name_idx ON domains (lower(name));
CREATE INDEX domains_user_idx ON domains (user_id);

CREATE TABLE domain_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  type TEXT NOT NULL,
  host TEXT NOT NULL,
  value TEXT NOT NULL,
  priority INTEGER,
  ttl TEXT NOT NULL DEFAULT 'Auto',
  required BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'pending',
  observed TEXT,
  checked_at TIMESTAMPTZ,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX domain_records_domain_idx ON domain_records (domain_id, position);

CREATE TABLE dkim_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  selector TEXT NOT NULL,
  cname_target TEXT NOT NULL,
  private_key TEXT NOT NULL,
  public_key TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT false,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  UNIQUE (domain_id, selector)
);
CREATE UNIQUE INDEX dkim_keys_active_idx ON dkim_keys (domain_id) WHERE active;

-- ----------------------------------------------------------------- filters --

CREATE TABLE filters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  script TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  compile_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

-- --------------------------------------------------------------- addresses --

CREATE TABLE addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  local_part TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'standard',
  name TEXT,
  password_hash TEXT,
  filter_id UUID REFERENCES filters(id) ON DELETE SET NULL,
  bytes_used BIGINT NOT NULL DEFAULT 0,
  daily_in_limit INTEGER,
  daily_out_limit INTEGER,
  disabled BOOLEAN NOT NULL DEFAULT false,
  last_login_at TIMESTAMPTZ,
  password_changed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (domain_id, local_part)
);
CREATE INDEX addresses_domain_idx ON addresses (domain_id);
-- At most one catch-all per domain, or delivery of an unmatched recipient would
-- have to pick between them.
CREATE UNIQUE INDEX addresses_catchall_idx
  ON addresses (domain_id) WHERE type = 'catchall';

CREATE TABLE address_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_id UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (address_id, destination)
);

ALTER TABLE tokens
  ADD CONSTRAINT tokens_address_fk
  FOREIGN KEY (address_id) REFERENCES addresses(id) ON DELETE CASCADE;

-- -------------------------------------------------------------- mail store --

CREATE TABLE folders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_id UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  special_use TEXT,
  uid_validity BIGINT NOT NULL,
  uid_next BIGINT NOT NULL DEFAULT 1,
  highest_modseq BIGINT NOT NULL DEFAULT 1,
  subscribed BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (address_id, name)
);
CREATE UNIQUE INDEX folders_special_use_idx
  ON folders (address_id, special_use) WHERE special_use IS NOT NULL;

CREATE TABLE messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  address_id UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  uid BIGINT NOT NULL,
  modseq BIGINT NOT NULL DEFAULT 1,
  flags JSONB NOT NULL DEFAULT '[]'::jsonb,
  internal_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  size INTEGER NOT NULL,
  storage_key TEXT,
  message_id TEXT,
  in_reply_to TEXT,
  thread_id TEXT,
  subject TEXT,
  from_address TEXT,
  to_addresses JSONB,
  cc_addresses JSONB,
  envelope JSONB,
  body_structure JSONB,
  snippet TEXT,
  search_text TEXT,
  has_attachments BOOLEAN NOT NULL DEFAULT false,
  spam_score REAL,
  expunged_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (folder_id, uid)
);
-- The sequence-number ordering IMAP works in is UID order within a folder,
-- filtered to live rows. Every SELECT, FETCH, and SEARCH starts here.
CREATE INDEX messages_folder_uid_idx
  ON messages (folder_id, uid) WHERE expunged_at IS NULL;
CREATE INDEX messages_folder_modseq_idx ON messages (folder_id, modseq);
CREATE INDEX messages_address_idx ON messages (address_id);
CREATE INDEX messages_thread_idx ON messages (address_id, thread_id);
CREATE INDEX messages_search_idx
  ON messages USING gin (to_tsvector('simple', coalesce(search_text, '')));

CREATE TABLE message_blobs (
  message_id UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  data TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE message_tombstones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  uid BIGINT NOT NULL,
  modseq BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX message_tombstones_folder_idx ON message_tombstones (folder_id, modseq);

-- ---------------------------------------------------------------- delivery --

CREATE TABLE deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_id UUID REFERENCES addresses(id) ON DELETE SET NULL,
  domain_id UUID REFERENCES domains(id) ON DELETE SET NULL,
  storage_key TEXT,
  message_id TEXT,
  mail_from TEXT NOT NULL,
  rcpt_to TEXT NOT NULL,
  next_hop TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 12,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_code INTEGER,
  last_error TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX deliveries_claim_idx
  ON deliveries (run_at) WHERE status IN ('queued', 'deferred');

CREATE TABLE mail_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  domain_id UUID REFERENCES domains(id) ON DELETE CASCADE,
  address_id UUID REFERENCES addresses(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,
  status TEXT NOT NULL,
  mail_from TEXT,
  rcpt_to TEXT,
  subject TEXT,
  message_id TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  remote_ip TEXT,
  remote_host TEXT,
  spf TEXT,
  dkim TEXT,
  dmarc TEXT,
  spam_score REAL,
  code INTEGER,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Both the daily quota check and the activity charts scan by owner over a time
-- window, so that is the index.
CREATE INDEX mail_log_user_time_idx ON mail_log (user_id, created_at DESC);
CREATE INDEX mail_log_address_time_idx ON mail_log (address_id, created_at DESC);
CREATE INDEX mail_log_domain_time_idx ON mail_log (domain_id, created_at DESC);

CREATE TABLE bounces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID REFERENCES domains(id) ON DELETE CASCADE,
  address_id UUID REFERENCES addresses(id) ON DELETE SET NULL,
  recipient TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'hard',
  code INTEGER,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bounces_recipient_idx ON bounces (lower(recipient), created_at DESC);

-- --------------------------------------------------------------- transfers --

CREATE TABLE transfers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address_id UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  server TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 993,
  secure BOOLEAN NOT NULL DEFAULT true,
  username TEXT NOT NULL,
  password_enc TEXT,
  message_limit INTEGER,
  size_limit BIGINT,
  newer_than TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'queued',
  folders_total INTEGER NOT NULL DEFAULT 0,
  folders_done INTEGER NOT NULL DEFAULT 0,
  messages_total INTEGER NOT NULL DEFAULT 0,
  messages_done INTEGER NOT NULL DEFAULT 0,
  bytes_done BIGINT NOT NULL DEFAULT 0,
  last_error TEXT,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transfers_user_idx ON transfers (user_id, created_at DESC);

-- --------------------------------------------------------------------- ops --

CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  locked_at TIMESTAMPTZ,
  locked_by TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX jobs_claim_idx ON jobs (status, run_at) WHERE status = 'pending';

CREATE TABLE rate_limits (
  bucket TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_started_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE audit_events (
  id SERIAL PRIMARY KEY,
  user_id TEXT,
  event TEXT NOT NULL,
  metadata TEXT,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created_idx ON audit_events (created_at DESC);

CREATE TABLE auth_failures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ip TEXT NOT NULL,
  protocol TEXT NOT NULL,
  username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_failures_ip_idx ON auth_failures (ip, created_at DESC);

CREATE TABLE bans (
  ip TEXT PRIMARY KEY,
  reason TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
