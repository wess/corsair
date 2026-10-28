-- Contacts, served over CardDAV (RFC 6352) and read by the webmail's recipient
-- autocomplete.
--
-- A book's sync_token is its modseq: each contact write advances it in the same
-- transaction and stamps the contact with the new value, so "what changed since
-- token N" is `modseq > N`. Deleted contacts stay as tombstones (deleted_at set,
-- vcard emptied) so sync-collection can report them.
CREATE TABLE address_books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_id UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  sync_token BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The default book is created lazily on first use; two clients discovering at
  -- once must both land on the same row.
  CONSTRAINT address_books_slug_key UNIQUE (address_id, slug)
);

CREATE TABLE contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL REFERENCES address_books(id) ON DELETE CASCADE,
  address_id UUID NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  href TEXT NOT NULL,
  uid TEXT NOT NULL,
  etag TEXT NOT NULL,
  vcard TEXT NOT NULL,
  size INTEGER NOT NULL,
  full_name TEXT,
  emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  modseq BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  -- A tombstone keeps its href, and a later PUT to the same name revives it.
  CONSTRAINT contacts_href_key UNIQUE (book_id, href)
);
-- RFC 6352 5.1: a UID is unique within a book. Tombstones do not count.
CREATE UNIQUE INDEX contacts_uid_idx ON contacts (book_id, uid) WHERE deleted_at IS NULL;
CREATE INDEX contacts_sync_idx ON contacts (book_id, modseq);
CREATE INDEX contacts_address_idx ON contacts (address_id) WHERE deleted_at IS NULL;
