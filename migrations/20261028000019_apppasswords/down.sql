ALTER TABLE addresses DROP COLUMN IF EXISTS require_app_passwords;
DROP TABLE IF EXISTS app_passwords;
