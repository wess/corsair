-- Administration, separated from ownership.
--
-- Two different questions, so two different grants. "Who may act on every
-- account on this server" is the operator's decision and lives on the user.
-- "Who may run this domain's mailboxes" belongs to whoever owns that domain,
-- and is a row per pair.
--
-- Neither is ownership. `users.is_owner` still means exactly one account, still
-- claimed at first signup and still guarded by `users_single_owner_idx`, and
-- the things that spend money or destroy data — billing, plans, transfers,
-- deleting a domain — stay with the owner of the thing. An administrator
-- manages mailboxes; that is the job being delegated and nothing wider.

ALTER TABLE users ADD COLUMN is_admin BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE domain_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain_id UUID NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Who granted it, kept for the audit trail rather than for any check.
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Granting the same person twice is a no-op, not a second grant; the route
-- upserts on this.
CREATE UNIQUE INDEX domain_admins_pair_idx ON domain_admins (domain_id, user_id);
-- "Which domains may this person administer?" runs on every domain listing.
CREATE INDEX domain_admins_user_idx ON domain_admins (user_id);
