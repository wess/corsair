ALTER TABLE users DROP CONSTRAINT IF EXISTS users_storage_state_chk;
ALTER TABLE users DROP COLUMN IF EXISTS storage_state;
