-- One password for the panel and the mailbox, where they are the same person.
--
-- A mailbox that belongs to a control-panel account carries a link to it and no
-- password of its own; SMTP, IMAP, POP3, and the webmail all verify against the
-- account's hash. Changing the account password changes the mailbox password
-- because there is only one.
--
-- Deliberately nullable. A mailbox that is NOT a panel account — the other
-- people on a family or team domain — keeps its own `password_hash` and has no
-- panel login at all. Those are still two identities, and this only merges the
-- case where they were always one person holding two credentials.
--
-- ON DELETE SET NULL rather than CASCADE: deleting a control-panel account must
-- not delete a mailbox and everything in it. The mailbox survives with no
-- password, which locks it rather than destroying it.
ALTER TABLE addresses
  ADD COLUMN user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX addresses_user_idx ON addresses (user_id);

-- A control-panel account backs at most one mailbox. Without this, two
-- addresses could both claim the same account and it would be ambiguous which
-- one a password change was meant for.
CREATE UNIQUE INDEX addresses_user_unique_idx ON addresses (user_id)
  WHERE user_id IS NOT NULL;
