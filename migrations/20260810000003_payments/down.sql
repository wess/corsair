DROP TABLE IF EXISTS payment_events;
DROP INDEX IF EXISTS users_provider_customer_idx;
ALTER TABLE users DROP COLUMN IF EXISTS provider_customer_ref;
ALTER TABLE plans DROP COLUMN IF EXISTS yearly_price_ref;
ALTER TABLE plans DROP COLUMN IF EXISTS monthly_price_ref;
