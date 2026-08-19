-- A domain administrator can be a mailbox, not only a panel account.
--
-- The first cut required a `users` row, which meant the person running a
-- client's mail needed a second identity and a second password, and had to be
-- sent to a control panel full of billing, plans and transfers that are not
-- theirs. The delegate people actually have is a mailbox — james@theirdomain —
-- and that is now what can hold the grant.
--
-- This does NOT let a mailbox credential open the control panel; `/app` still
-- refuses it, and `issueMailSession` still explains why. It lets a mailbox
-- session reach one narrow surface inside the webmail, scoped to the domains
-- named here. Both subjects stay possible: a colleague with a panel account is
-- still granted by `user_id`.

ALTER TABLE domain_admins ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE domain_admins ADD COLUMN address_id UUID REFERENCES addresses(id) ON DELETE CASCADE;

-- Exactly one subject per row. A row with both would have two answers to "who
-- is this grant for", and a row with neither grants nothing to nobody.
ALTER TABLE domain_admins
  ADD CONSTRAINT domain_admins_subject_chk CHECK (num_nonnulls(user_id, address_id) = 1);

-- Both uniqueness rules become partial, because the column they cover is now
-- nullable and NULLs do not collide.
DROP INDEX IF EXISTS domain_admins_pair_idx;
CREATE UNIQUE INDEX domain_admins_pair_idx ON domain_admins (domain_id, user_id)
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX domain_admins_address_pair_idx ON domain_admins (domain_id, address_id)
  WHERE address_id IS NOT NULL;

-- "Which domains may this mailbox administer?" runs on every webmail session.
CREATE INDEX domain_admins_address_idx ON domain_admins (address_id);
