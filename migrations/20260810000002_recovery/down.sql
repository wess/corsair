ALTER TABLE domains DROP COLUMN IF EXISTS dns_published_at;
ALTER TABLE domains DROP COLUMN IF EXISTS dns_provider;
ALTER TABLE addresses DROP COLUMN IF EXISTS recovery_address;
