-- An agent's daily send allowance, as a counter the database updates atomically.
--
-- The cap used to be a count of mail_log rows read before sending and written
-- after, which two concurrent requests can both pass. One UPDATE ... WHERE
-- count + n <= cap takes the row lock, so they cannot. The window is the UTC day
-- rather than a rolling 24 hours, which is what lets it be a single row. Kept
-- as TEXT (YYYY-MM-DD) because the schema layer has no date column.
ALTER TABLE agents
  ADD COLUMN sent_on TEXT,
  ADD COLUMN sent_count INTEGER NOT NULL DEFAULT 0;
