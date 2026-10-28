-- Where an account stands against its storage limit, as last announced.
--
-- quota.warning and quota.exceeded are transitions, not readings: the owner is
-- told once when the account crosses 90% and once when it fills, not on every
-- delivery or every sweep. This column is the memory of what they were last
-- told, and moving it is the claim on telling them.
ALTER TABLE users ADD COLUMN storage_state TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE users ADD CONSTRAINT users_storage_state_chk
  CHECK (storage_state IN ('ok', 'warning', 'exceeded'));
