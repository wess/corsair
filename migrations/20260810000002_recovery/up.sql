-- Where an address-recovery link is sent. Deliberately a different mailbox from
-- the one being recovered: sending the reset link to the mailbox whose password
-- was lost helps nobody.
ALTER TABLE addresses ADD COLUMN recovery_address TEXT;

-- Which DNS provider a domain resolves through, cached from its NS records so
-- the setup screen can offer the right one-click flow without re-querying.
ALTER TABLE domains ADD COLUMN dns_provider TEXT;
ALTER TABLE domains ADD COLUMN dns_published_at TIMESTAMPTZ;
