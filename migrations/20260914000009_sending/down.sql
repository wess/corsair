DROP TABLE IF EXISTS idempotency_keys;
DROP TABLE IF EXISTS suppressions;
DROP INDEX IF EXISTS deliveries_email_idx;
ALTER TABLE deliveries DROP COLUMN IF EXISTS email_id;
DROP TABLE IF EXISTS emails;
DROP TABLE IF EXISTS api_keys;
