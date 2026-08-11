CREATE UNIQUE INDEX addresses_user_unique_idx ON addresses (user_id)
  WHERE user_id IS NOT NULL;
