DROP INDEX IF EXISTS addresses_user_unique_idx;
DROP INDEX IF EXISTS addresses_user_idx;
ALTER TABLE addresses DROP COLUMN IF EXISTS user_id;
