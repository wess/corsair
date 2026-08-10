-- The provider's own price identifier, so a hosted checkout can be started for
-- a plan without hard-coding it in the panel.
ALTER TABLE plans ADD COLUMN monthly_price_ref TEXT;
ALTER TABLE plans ADD COLUMN yearly_price_ref TEXT;

-- The provider's customer record for this account. One per user, created
-- lazily the first time they reach checkout.
ALTER TABLE users ADD COLUMN provider_customer_ref TEXT;
CREATE UNIQUE INDEX users_provider_customer_idx
  ON users (provider_customer_ref) WHERE provider_customer_ref IS NOT NULL;

-- Webhook deliveries are recorded so a replayed or duplicated event is applied
-- once. Providers retry aggressively and will send the same event again.
CREATE TABLE payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,
  event_ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, event_ref)
);
