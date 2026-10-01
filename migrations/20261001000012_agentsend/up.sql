-- Whether an agent may send mail from its address. Off by default: an agent
-- that can only read cannot be turned into a spam source by a prompt injection
-- in the mail it reads. Turning it on also caps the mailbox's daily sends.
ALTER TABLE agents ADD COLUMN can_send BOOLEAN NOT NULL DEFAULT false;
