-- Greylisting and trusted correspondents, both inputs to inbound spam handling.
--
-- A greylist row is one (client network, envelope sender, recipient) triplet.
-- The network is the /24 or /64, not the address: a large sender retries from a
-- different machine in the same pool, and keying on the exact address would
-- defer it forever. `passed_at` set means the triplet is whitelisted until
-- `last_seen` is 36 days old; the worker prunes everything older than that.
CREATE TABLE greylist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_net TEXT NOT NULL,
  sender TEXT NOT NULL,
  sender_domain TEXT NOT NULL,
  recipient TEXT NOT NULL,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  passed_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX greylist_triplet_idx ON greylist (client_net, sender, recipient);
CREATE INDEX greylist_net_passed_idx ON greylist (client_net, last_seen) WHERE passed_at IS NOT NULL;
CREATE INDEX greylist_domain_passed_idx ON greylist (sender_domain, last_seen) WHERE passed_at IS NOT NULL;
CREATE INDEX greylist_last_seen_idx ON greylist (last_seen);

-- The people a mailbox has written to. Mail back from one of them, when it is
-- authenticated as theirs, is the strongest "not spam" signal there is and needs
-- no corpus. Capped per mailbox by the writer, least recently used first.
CREATE TABLE correspondents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_id UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  last_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX correspondents_address_email_idx ON correspondents (address_id, email);
CREATE INDEX correspondents_address_last_idx ON correspondents (address_id, last_at);
