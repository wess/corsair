CREATE INDEX messages_storage_live_idx ON messages (storage_key)
  WHERE storage_key IS NOT NULL AND expunged_at IS NULL;
