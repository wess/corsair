-- Outbound event hooks: the customer's endpoint, what it wants, and how to
-- prove a delivery came from us.
CREATE TABLE webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Null means every domain on the account. A domain-scoped hook only receives
  -- events for that domain, which is what a customer reselling mailboxes wants.
  domain_id UUID REFERENCES domains(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  description TEXT,
  events JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'enabled',
  signing_secret TEXT NOT NULL,
  -- Set when a hook is auto-disabled after repeated total failure, so the panel
  -- can say why rather than showing a silently dead endpoint.
  disabled_reason TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_success_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhooks_user_idx ON webhooks (user_id);
CREATE INDEX webhooks_domain_idx ON webhooks (domain_id) WHERE domain_id IS NOT NULL;

-- One row per (event, endpoint). The id is the idempotency key the receiver
-- sees, so a retry is recognisable as the same delivery rather than a new one.
CREATE TABLE webhook_events (
  id TEXT PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_claim_idx
  ON webhook_events (next_attempt_at) WHERE status = 'pending';
CREATE INDEX webhook_events_hook_idx ON webhook_events (webhook_id, created_at DESC);

-- Every attempt, kept so a customer debugging their endpoint can see the exact
-- status and body we got back rather than guessing.
CREATE TABLE webhook_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_event_id TEXT NOT NULL REFERENCES webhook_events(id) ON DELETE CASCADE,
  webhook_id UUID NOT NULL,
  http_status_code INTEGER,
  response TEXT,
  error TEXT,
  duration_ms INTEGER,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX webhook_attempts_event_idx ON webhook_attempts (webhook_event_id, sent_at DESC);
