DROP INDEX IF EXISTS domain_admins_address_idx;
DROP INDEX IF EXISTS domain_admins_address_pair_idx;
ALTER TABLE domain_admins DROP CONSTRAINT IF EXISTS domain_admins_subject_chk;
DELETE FROM domain_admins WHERE user_id IS NULL;
ALTER TABLE domain_admins DROP COLUMN IF EXISTS address_id;
ALTER TABLE domain_admins ALTER COLUMN user_id SET NOT NULL;
DROP INDEX IF EXISTS domain_admins_pair_idx;
CREATE UNIQUE INDEX domain_admins_pair_idx ON domain_admins (domain_id, user_id);
