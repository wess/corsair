-- How far the retention sweep has deleted tombstones in each folder.
--
-- QRESYNC tells a reconnecting client which UIDs vanished since the modseq it
-- last saw, and the tombstones are the only record of that. Once the sweep has
-- removed tombstones newer than the client's modseq, an answer built from what
-- remains silently omits messages, and the client keeps showing mail that is
-- gone. Below this floor the server reports every UID that is not live instead.
ALTER TABLE folders ADD COLUMN vanished_floor BIGINT NOT NULL DEFAULT 0;
