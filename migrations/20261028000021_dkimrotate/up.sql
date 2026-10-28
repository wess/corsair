-- Rotation state for the installation's DKIM selector hosts.
--
-- dkim_keys has one row per domain per host, all rows for a host sharing one
-- keypair, so "which phase is this key in" cannot live there: it is a fact about
-- the host, and the per-domain `active` flag only says which host a domain signs
-- with right now. A host moves spare -> staged -> published -> active ->
-- retiring -> revoked, and only a host in `active` or `retiring` has a key any
-- domain may sign with.
CREATE TABLE dkim_hosts (
  host TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'spare'
    CHECK (phase IN ('spare', 'staged', 'published', 'active', 'retiring', 'revoked')),
  phase_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one active host. The constant expression makes every active row collide.
CREATE UNIQUE INDEX dkim_hosts_active_idx ON dkim_hosts ((true)) WHERE phase = 'active';
