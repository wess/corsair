import { createHash, randomUUID } from "node:crypto"
import { allColumns, type Connection, db, num } from "../db/index.ts"
import { type Address, type AddressBook, type Contact, contacts } from "../schema/index.ts"

/**
 * Contacts: one address book per mailbox, stored as vCards.
 *
 * CardDAV (`src/carddav`) is the protocol; this is the store, and the webmail's
 * autocomplete reads the same rows. The vCard text a client PUTs is kept
 * verbatim and served back byte for byte — clients compare what they get to
 * what they wrote, and a server that normalises a card hands every client a
 * conflict on its next sync.
 */

/** Large enough for a card with a photo; small enough that a book stays cheap to query. */
export const MAX_VCARD_BYTES = 256 * 1024

const MAX_LINES = 5_000

/**
 * Who has an address book. A person's mailbox does; an alias or group is a
 * routing entry, and an agent's mailbox is a token-holding harness whose reads
 * should stay its mail — a contact list it can write is a place for a prompt
 * injection to plant addresses that later autocomplete into a person's compose.
 */
export const contactsAllowed = (address: Address): boolean =>
  !address.disabled && (address.type === "standard" || address.type === "catchall")

// vCard

export type VcardProperty = {
  group: string | null
  name: string
  params: Record<string, string[]>
  value: string
}

export type Vcard = {
  version: string
  uid: string | null
  fullName: string | null
  emails: string[]
  properties: VcardProperty[]
}

const invalid = (message: string): never => {
  throw Object.assign(new Error(message), { vcard: true })
}

export const isVcardError = (error: unknown): boolean =>
  Boolean((error as { vcard?: boolean } | null)?.vcard)

/** RFC 6350 3.4 escapes, which 2426 shares. */
export const unescapeValue = (value: string): string =>
  value.replace(/\\([\\,;nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c))

export const escapeValue = (value: string): string =>
  value.replace(/[\\,;]/g, (c) => `\\${c}`).replace(/\r?\n/g, "\\n")

/** Splits on `sep` outside double quotes — a parameter value may contain `:` or `;`. */
const splitUnquoted = (input: string, sep: string): string[] => {
  const out: string[] = []
  let quoted = false
  let start = 0
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"') quoted = !quoted
    else if (ch === sep && !quoted) {
      out.push(input.slice(start, i))
      start = i + 1
    }
  }
  out.push(input.slice(start))
  return out
}

const parseLine = (line: string): VcardProperty => {
  let quoted = false
  let colon = -1
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted
    else if (line[i] === ":" && !quoted) {
      colon = i
      break
    }
  }
  if (colon <= 0) invalid(`not a vCard property: ${line.slice(0, 40)}`)

  const [head = "", ...rawParams] = splitUnquoted(line.slice(0, colon), ";")
  const dot = head.indexOf(".")
  const group = dot === -1 ? null : head.slice(0, dot)
  const name = (dot === -1 ? head : head.slice(dot + 1)).toUpperCase()
  if (!/^[A-Z0-9-]+$/.test(name)) invalid(`bad property name: ${name.slice(0, 40)}`)

  const params: Record<string, string[]> = {}
  for (const raw of rawParams) {
    const eq = raw.indexOf("=")
    // vCard 2.1 bare parameters ("TEL;HOME:") are a TYPE.
    const key = (eq === -1 ? "TYPE" : raw.slice(0, eq)).toUpperCase()
    const values = eq === -1 ? [raw] : splitUnquoted(raw.slice(eq + 1), ",")
    params[key] = [...(params[key] ?? []), ...values.map((v) => v.replace(/^"|"$/g, ""))]
  }
  return { group, name, params, value: line.slice(colon + 1) }
}

/**
 * Parses exactly one vCard 3.0 or 4.0.
 *
 * Strict where it protects the store (one card, a version we can serve, a size
 * and line cap) and lenient where real clients differ: FN and UID are optional
 * here, because old 3.0 clients omit UID and the CardDAV layer falls back to the
 * resource name.
 */
export const parseVcard = (text: string): Vcard => {
  const lines = text
    .replace(/\r\n|\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .filter((line) => line.length > 0)
  if (lines.length > MAX_LINES) invalid("too many lines")

  if (lines[0]?.toUpperCase() !== "BEGIN:VCARD") invalid("does not start with BEGIN:VCARD")
  if (lines[lines.length - 1]?.toUpperCase() !== "END:VCARD") invalid("does not end with END:VCARD")

  const properties = lines.slice(1, -1).map(parseLine)
  // A nested BEGIN is a second card (or an AGENT 2.1 relic). One resource holds
  // one card, so either is refused rather than half-stored.
  if (properties.some((p) => p.name === "BEGIN" || p.name === "END")) invalid("more than one vCard")

  const version = properties.find((p) => p.name === "VERSION")?.value.trim()
  if (version !== "3.0" && version !== "4.0") invalid("VERSION must be 3.0 or 4.0")

  const first = (name: string) => properties.find((p) => p.name === name)
  const uidValue = first("UID")?.value.trim() ?? ""
  const fn = first("FN") ? unescapeValue(first("FN")!.value).trim() : ""

  const emails = properties
    .filter((p) => p.name === "EMAIL")
    .map((p) =>
      unescapeValue(p.value)
        .trim()
        .replace(/^mailto:/i, ""),
    )
    .filter((e) => e.length > 0 && e.length <= 320)

  return {
    version: version as string,
    uid: uidValue ? uidValue.slice(0, 500) : null,
    fullName: fn ? fn.slice(0, 500) : null,
    emails: [...new Set(emails)].slice(0, 100),
    properties,
  }
}

const fold = (line: string): string => {
  // 75 octets per RFC 6350 3.2; counting characters is close enough for the
  // ASCII this writes, and clients unfold regardless.
  if (line.length <= 75) return line
  const parts = [line.slice(0, 75)]
  for (let i = 75; i < line.length; i += 74) parts.push(` ${line.slice(i, i + 74)}`)
  return parts.join("\r\n")
}

/** A fresh 3.0 card — the version every client in the wild reads. */
export const buildVcard = (input: { uid: string; name: string; emails: string[] }): string => {
  const name = input.name.trim()
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${escapeValue(input.uid)}`,
    `FN:${escapeValue(name)}`,
    `N:${escapeValue(name)};;;;`,
    ...input.emails.map((e) => `EMAIL;TYPE=INTERNET:${escapeValue(e)}`),
    "END:VCARD",
    "",
  ]
    .map(fold)
    .join("\r\n")
}

/**
 * Replaces the name and email lines of an existing card and keeps the rest.
 *
 * The webmail edits only those two fields, and a phone number or photo some
 * other client wrote must survive it. Lines are kept as written, folding and
 * all, so nothing the webmail did not touch changes.
 */
export const editVcard = (text: string, input: { name: string; emails: string[] }): string => {
  const card = parseVcard(text)
  const raw = text.replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "\n\u0000")
  const physical = raw.split("\n").filter((l) => l.length > 0)

  // Rejoin folded continuations so each entry is one logical property.
  const logical: string[] = []
  for (const line of physical) {
    if (line.startsWith("\u0000") && logical.length) {
      logical[logical.length - 1] += `\r\n ${line.slice(1)}`
    } else logical.push(line)
  }

  const nameOf = (line: string) => {
    const head = line.split(/[;:]/, 1)[0] ?? ""
    return head.slice(head.indexOf(".") + 1).toUpperCase()
  }
  const kept = logical.filter((line) => !["FN", "EMAIL", "END"].includes(nameOf(line)))
  const hasN = card.properties.some((p) => p.name === "N")
  const name = input.name.trim()

  return [
    ...kept,
    `FN:${escapeValue(name)}`,
    ...(hasN || card.version === "4.0" ? [] : [`N:${escapeValue(name)};;;;`]),
    ...input.emails.map((e) =>
      card.version === "4.0" ? `EMAIL:${escapeValue(e)}` : `EMAIL;TYPE=INTERNET:${escapeValue(e)}`,
    ),
    "END:VCARD",
    "",
  ]
    .map((line) => (line.includes("\r\n") ? line : fold(line)))
    .join("\r\n")
}

export const etagOf = (vcard: string): string =>
  createHash("sha256").update(vcard).digest("hex").slice(0, 32)

// store

export const DEFAULT_BOOK = "default"

/**
 * The mailbox's default book, created on first use.
 *
 * Lazily rather than with the address, so existing mailboxes need no backfill
 * and a mailbox that never syncs contacts never has a row. The unique
 * constraint makes two concurrent first requests agree on one book.
 */
export const defaultBook = async (addressId: string): Promise<AddressBook> => {
  await db().execute({
    text: `INSERT INTO address_books (address_id, slug, name) VALUES ($1, $2, 'Contacts')
           ON CONFLICT (address_id, slug) DO NOTHING`,
    values: [addressId, DEFAULT_BOOK],
  })
  const row = await db().one<AddressBook>({
    text: "SELECT * FROM address_books WHERE address_id = $1 AND slug = $2",
    values: [addressId, DEFAULT_BOOK],
  })
  if (!row) throw new Error(`address book for ${addressId} vanished`)
  return row
}

export const bookToken = async (bookId: string): Promise<number> => {
  const row = await db().one<{ sync_token: bigint }>({
    text: "SELECT sync_token FROM address_books WHERE id = $1",
    values: [bookId],
  })
  return num(row?.sync_token)
}

export const liveContacts = (bookId: string): Promise<Contact[]> =>
  db().all<Contact>({
    text: "SELECT * FROM contacts WHERE book_id = $1 AND deleted_at IS NULL ORDER BY href",
    values: [bookId],
  })

export const contactByHref = (bookId: string, href: string): Promise<Contact | null> =>
  db().one<Contact>({
    text: "SELECT * FROM contacts WHERE book_id = $1 AND href = $2 AND deleted_at IS NULL",
    values: [bookId, href],
  })

/** Everything that changed after `since`, tombstones included. */
export const changesSince = (bookId: string, since: number): Promise<Contact[]> =>
  db().all<Contact>({
    text: "SELECT * FROM contacts WHERE book_id = $1 AND modseq > $2 ORDER BY modseq",
    values: [bookId, since],
  })

/**
 * A resource name a client may choose. Clients pick their own (a UUID plus
 * `.vcf` from most, something with a colon from older Apple ones), and the name
 * is echoed back in every listing, so anything printable is accepted except what
 * would change the path's meaning.
 */
export const validHref = (href: string): boolean =>
  href.length > 0 &&
  href.length <= 255 &&
  !href.startsWith(".") &&
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them is the point
  !/[\u0000-\u001f\u007f/\\?#%]/.test(href)

export type Precondition = {
  /** `*` means "must exist"; a value means "must currently have this etag". */
  ifMatch?: string | null
  /** `*` means "must not exist". */
  ifNoneMatch?: string | null
}

export type WriteResult =
  | { ok: true; contact: Contact; created: boolean }
  | { ok: false; reason: "precondition" | "uid_conflict" | "not_found"; href?: string }

const matches = (header: string, etag: string): boolean =>
  header
    .split(",")
    .map((v) => v.trim().replace(/^W\//, ""))
    .some((v) => v === "*" || v === `"${etag}"`)

const checkPrecondition = (existing: Contact | null, pre: Precondition): boolean => {
  if (pre.ifNoneMatch) {
    if (existing && (pre.ifNoneMatch.trim() === "*" || matches(pre.ifNoneMatch, existing.etag)))
      return false
  }
  if (pre.ifMatch) {
    if (!existing || !matches(pre.ifMatch, existing.etag)) return false
  }
  return true
}

/** Advances the book's token and takes its row lock for the rest of the transaction. */
const nextToken = async (conn: Connection, bookId: string): Promise<bigint> => {
  const row = await conn.one<{ sync_token: string }>({
    text: `UPDATE address_books SET sync_token = sync_token + 1 WHERE id = $1
        RETURNING sync_token::text AS sync_token`,
    values: [bookId],
  })
  if (!row) throw new Error(`address book ${bookId} does not exist`)
  return BigInt(row.sync_token)
}

/**
 * Creates or replaces one card. The precondition is evaluated under the book's
 * row lock, so two clients both holding the same etag cannot both win.
 */
export const putContact = async (input: {
  book: AddressBook
  href: string
  vcard: string
  precondition?: Precondition
}): Promise<WriteResult> => {
  const card = parseVcard(input.vcard)
  const uid = card.uid ?? input.href.replace(/\.vcf$/i, "")
  const etag = etagOf(input.vcard)

  return db()
    .transaction(async (conn) => {
      const modseq = await nextToken(conn, input.book.id)
      const existing = await conn.one<Contact>({
        text: "SELECT * FROM contacts WHERE book_id = $1 AND href = $2 AND deleted_at IS NULL",
        values: [input.book.id, input.href],
      })
      if (!checkPrecondition(existing, input.precondition ?? {})) {
        throw Object.assign(new Error("precondition"), {
          write: { ok: false, reason: "precondition" },
        })
      }
      const clash = await conn.one<{ href: string }>({
        text: `SELECT href FROM contacts
              WHERE book_id = $1 AND uid = $2 AND href <> $3 AND deleted_at IS NULL`,
        values: [input.book.id, uid, input.href],
      })
      if (clash) {
        throw Object.assign(new Error("uid"), {
          write: { ok: false, reason: "uid_conflict", href: clash.href },
        })
      }

      const row = await conn.one<Contact>({
        text: `INSERT INTO contacts
               (book_id, address_id, href, uid, etag, vcard, size, full_name, emails, modseq)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
             ON CONFLICT (book_id, href) DO UPDATE SET
               uid = EXCLUDED.uid, etag = EXCLUDED.etag, vcard = EXCLUDED.vcard,
               size = EXCLUDED.size, full_name = EXCLUDED.full_name, emails = EXCLUDED.emails,
               modseq = EXCLUDED.modseq, updated_at = now(), deleted_at = NULL
             RETURNING ${allColumns(contacts).join(", ")}`,
        values: [
          input.book.id,
          input.book.address_id,
          input.href,
          uid,
          etag,
          input.vcard,
          Buffer.byteLength(input.vcard, "utf8"),
          card.fullName,
          // The array itself: Bun encodes it as JSON for a jsonb parameter, and a
          // JSON.stringify'd copy would be stored as one jsonb *string*.
          card.emails,
          modseq,
        ],
      })
      return { ok: true as const, contact: row as Contact, created: !existing }
    })
    .catch((error: { write?: WriteResult }) => {
      if (error?.write) return error.write
      throw error
    })
}

/** Leaves a tombstone so sync-collection can report the deletion. */
export const deleteContact = async (input: {
  book: AddressBook
  href: string
  precondition?: Precondition
}): Promise<WriteResult> =>
  db()
    .transaction(async (conn) => {
      const modseq = await nextToken(conn, input.book.id)
      const existing = await conn.one<Contact>({
        text: "SELECT * FROM contacts WHERE book_id = $1 AND href = $2 AND deleted_at IS NULL",
        values: [input.book.id, input.href],
      })
      if (!existing) {
        throw Object.assign(new Error("missing"), { write: { ok: false, reason: "not_found" } })
      }
      if (!checkPrecondition(existing, input.precondition ?? {})) {
        throw Object.assign(new Error("precondition"), {
          write: { ok: false, reason: "precondition" },
        })
      }
      const row = await conn.one<Contact>({
        text: `UPDATE contacts SET vcard = '', size = 0, full_name = NULL, emails = '[]'::jsonb,
                      modseq = $2, updated_at = now(), deleted_at = now()
                WHERE id = $1
            RETURNING ${allColumns(contacts).join(", ")}`,
        values: [existing.id, modseq],
      })
      return { ok: true as const, contact: row as Contact, created: false }
    })
    .catch((error: { write?: WriteResult }) => {
      if (error?.write) return error.write
      throw error
    })

/** A new card from the webmail: a UUID names both the card and its resource. */
export const createContact = async (
  addressId: string,
  input: { name: string; emails: string[] },
): Promise<Contact> => {
  const book = await defaultBook(addressId)
  const uid = randomUUID()
  const result = await putContact({
    book,
    href: `${uid}.vcf`,
    vcard: buildVcard({ uid, ...input }),
    precondition: { ifNoneMatch: "*" },
  })
  if (!result.ok) throw new Error(`could not create contact: ${result.reason}`)
  return result.contact
}

const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * Recipient autocomplete. Scoped by `address_id` in the query itself, so a
 * contact id or a search can never reach another mailbox's book.
 */
export const searchContacts = (
  addressId: string,
  query: string,
  limit: number,
): Promise<Contact[]> => {
  const pattern = `%${escapeLike(query.trim())}%`
  return db().all<Contact>({
    text: `SELECT ${allColumns(contacts).join(", ")} FROM contacts c
            WHERE c.address_id = $1 AND c.deleted_at IS NULL
              AND ($2 = '%%' OR c.full_name ILIKE $2
                   OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(c.emails) e WHERE e ILIKE $2))
            ORDER BY lower(coalesce(c.full_name, c.emails->>0, '')), c.id
            LIMIT $3`,
    values: [addressId, pattern, limit],
  })
}

export const ownedContact = (addressId: string, id: string): Promise<Contact | null> =>
  db().one<Contact>({
    text: `SELECT * FROM contacts WHERE id = $1 AND address_id = $2 AND deleted_at IS NULL`,
    values: [id, addressId],
  })

export const bookOf = (contact: Contact): Promise<AddressBook | null> =>
  db().one<AddressBook>({
    text: "SELECT * FROM address_books WHERE id = $1",
    values: [contact.book_id],
  })
