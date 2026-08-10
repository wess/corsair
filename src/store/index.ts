import { from } from "@atlas/db"
import { allColumns, db, num } from "../db/index.ts"
import {
  attachmentParts,
  envelopeOf,
  headerValue,
  normalizeEol,
  type ParsedMessage,
  parseMessage,
  searchTextOf,
  snippetOf,
} from "../mime/index.ts"
import { type Folder, folders, type Message, messages } from "../schema/index.ts"
import { deleteRaw, messageKey, putInline, putRaw, storageEnabled } from "../storage/index.ts"

export type DeliverInput = {
  addressId: string
  folderId: string
  raw: string
  flags?: string[]
  internalDate?: Date
  spamScore?: number | null
}

/**
 * Claims the next UID and bumps the modification sequence in one statement.
 *
 * This has to be atomic: two messages arriving at the same folder in the same
 * millisecond that both read `uid_next` before either writes it would be handed
 * the same UID, and a duplicate UID is the one thing an IMAP client cannot
 * recover from — it caches by UID forever. `UPDATE ... RETURNING` takes a row
 * lock and serialises the pair, so the second delivery waits.
 */
const claimUid = async (folderId: string): Promise<{ uid: bigint; modseq: bigint }> => {
  const row = await db().one<{ uid: string; modseq: string }>({
    text: `UPDATE folders
              SET uid_next = uid_next + 1,
                  highest_modseq = highest_modseq + 1,
                  updated_at = now()
            WHERE id = $1
        RETURNING (uid_next - 1)::text AS uid, highest_modseq::text AS modseq`,
    values: [folderId],
  })
  if (!row) throw new Error(`folder ${folderId} does not exist`)
  return { uid: BigInt(row.uid), modseq: BigInt(row.modseq) }
}

/** Bumps a folder's modseq without allocating a UID, for flag and expunge changes. */
export const bumpModseq = async (folderId: string): Promise<bigint> => {
  const row = await db().one<{ modseq: string }>({
    text: `UPDATE folders SET highest_modseq = highest_modseq + 1, updated_at = now()
            WHERE id = $1 RETURNING highest_modseq::text AS modseq`,
    values: [folderId],
  })
  return BigInt(row?.modseq ?? "1")
}

const addBytes = async (addressId: string, delta: number): Promise<void> => {
  // Clamped at zero: a recount that drifts negative would render as a nonsense
  // usage figure forever, and the periodic recompute will correct it anyway.
  await db().execute({
    text: `UPDATE addresses SET bytes_used = GREATEST(0, bytes_used + $2), updated_at = now()
            WHERE id = $1`,
    values: [addressId, delta],
  })
  await db().execute({
    text: `UPDATE domains SET bytes_used = GREATEST(0, bytes_used + $2), updated_at = now()
            WHERE id = (SELECT domain_id FROM addresses WHERE id = $1)`,
    values: [addressId, delta],
  })
}

/**
 * Writes a message into a folder. The single path every source of new mail goes
 * through — SMTP delivery, IMAP APPEND, and the migration worker — so that UID
 * allocation, quota accounting, and header extraction cannot drift apart.
 */
export const deliver = async (input: DeliverInput): Promise<Message> => {
  const raw = normalizeEol(input.raw)
  const parsed = parseMessage(raw)
  const size = raw.length

  const { uid, modseq } = await claimUid(input.folderId)
  const envelope = envelopeOf(parsed)

  const row = (await db().one<Message>(
    from(messages)
      .insert({
        folder_id: input.folderId,
        address_id: input.addressId,
        uid,
        modseq,
        flags: input.flags ?? [],
        internal_date: input.internalDate ?? new Date(),
        size,
        message_id: envelope.message_id,
        in_reply_to: envelope.in_reply_to,
        thread_id: threadIdOf(parsed, envelope.message_id),
        subject: envelope.subject,
        from_address: envelope.from[0] ?? null,
        to_addresses: envelope.to,
        cc_addresses: envelope.cc,
        envelope,
        snippet: snippetOf(raw, parsed),
        search_text: searchTextOf(raw, parsed),
        has_attachments: attachmentParts(parsed).length > 0,
        spam_score: input.spamScore ?? null,
      })
      .returning(...allColumns(messages)),
  ))!

  // The body is written after the row so a failure here leaves a message with
  // no body rather than a body with no message — the former is visible and
  // repairable, the latter is an invisible leak.
  if (storageEnabled()) {
    const key = messageKey(input.addressId, row.id, row.internal_date)
    await putRaw(key, raw)
    await db().execute(
      from(messages)
        .where((q) => q("id").equals(row.id))
        .update({ storage_key: key }),
    )
    row.storage_key = key
  } else {
    await putInline(row.id, raw)
  }

  await addBytes(input.addressId, size)
  return row
}

/**
 * Groups a reply with what it is replying to. References beats In-Reply-To
 * because the first entry of References is the root of the thread, whereas
 * In-Reply-To only reaches the immediate parent.
 */
const threadIdOf = (parsed: ParsedMessage, messageId: string | null): string | null => {
  const references = headerValue(parsed.headers, "references")
  const first = references?.trim().split(/\s+/)[0]
  if (first) return first
  return headerValue(parsed.headers, "in-reply-to") ?? messageId
}

// ---------------------------------------------------------------- mutate --

export const setFlags = async (
  messageId: string,
  folderId: string,
  flags: string[],
): Promise<bigint> => {
  const modseq = await bumpModseq(folderId)
  await db().execute(
    from(messages)
      .where((q) => q("id").equals(messageId))
      .update({ flags, modseq }),
  )
  return modseq
}

/**
 * Marks messages expunged and records tombstones so a client reconnecting with
 * QRESYNC can be told which UIDs vanished. The rows stay until the retention
 * sweep removes them, because deleting them immediately would leave a
 * reconnecting client unable to tell "gone" from "never existed".
 */
export const expunge = async (input: {
  folderId: string
  messageIds: string[]
}): Promise<{ uids: number[]; modseq: bigint }> => {
  if (!input.messageIds.length) return { uids: [], modseq: 0n }

  const modseq = await bumpModseq(input.folderId)
  const rows = await db().all<{
    id: string
    uid: string
    size: number
    address_id: string
    storage_key: string | null
  }>({
    text: `UPDATE messages
              SET expunged_at = now(), modseq = $2
            WHERE folder_id = $1
              AND expunged_at IS NULL
              AND id = ANY(SELECT jsonb_array_elements_text($3::jsonb)::uuid)
        RETURNING id, uid::text AS uid, size, address_id, storage_key`,
    // Bun's Postgres driver does not bind a JS array to a Postgres array, so
    // the list is expanded server-side from jsonb. The array goes in as-is —
    // pre-stringifying it produces a jsonb *scalar*, which Postgres refuses to
    // expand ("cannot extract elements from a scalar").
    values: [input.folderId, modseq, input.messageIds],
  })

  for (const row of rows) {
    await db().execute({
      text: "INSERT INTO message_tombstones (folder_id, uid, modseq) VALUES ($1, $2, $3)",
      values: [input.folderId, row.uid, modseq],
    })
  }

  const bytes = rows.reduce((sum, r) => sum + (r.size ?? 0), 0)
  if (bytes && rows[0]) await addBytes(rows[0].address_id, -bytes)

  // Bodies go last and best-effort; see the note in storage.
  for (const row of rows) await deleteRaw(row.storage_key)

  return { uids: rows.map((r) => Number(r.uid)), modseq }
}

/**
 * Moves messages between folders, keeping their row identity.
 *
 * Not a copy followed by an expunge, which is how `copyTo` + `expunge` would do
 * it: JMAP requires an Email's `id` to survive a change of mailbox, and a
 * client that has just moved a message will immediately fetch it by the id it
 * already holds. IMAP's requirements are met at the same time — the message
 * takes a fresh UID in the target folder and leaves a tombstone in the source,
 * so a client watching either folder sees the right thing.
 */
export const moveTo = async (input: {
  messageIds: string[]
  targetFolderId: string
}): Promise<{ moved: number }> => {
  if (!input.messageIds.length) return { moved: 0 }

  const rows = await db().all<Message>(
    from(messages).where((q) => [q("expunged_at").isNull(), q("id").inList(input.messageIds)]),
  )

  let moved = 0
  for (const row of rows) {
    if (row.folder_id === input.targetFolderId) continue

    const { uid, modseq } = await claimUid(input.targetFolderId)
    const sourceModseq = await bumpModseq(row.folder_id)

    // The tombstone goes in first: a client resyncing the source folder between
    // these two statements should be told the message left, not that it never
    // existed.
    await db().execute({
      text: "INSERT INTO message_tombstones (folder_id, uid, modseq) VALUES ($1, $2, $3)",
      values: [row.folder_id, row.uid, sourceModseq],
    })

    await db().execute(
      from(messages)
        .where((q) => q("id").equals(row.id))
        .update({ folder_id: input.targetFolderId, uid, modseq }),
    )
    moved++
  }

  return { moved }
}

export const copyTo = async (input: {
  messageIds: string[]
  targetFolderId: string
}): Promise<{ sourceUids: number[]; targetUids: number[] }> => {
  const source = await db().all<Message>(
    from(messages).where((q) => [q("expunged_at").isNull(), q("id").inList(input.messageIds)]),
  )

  const sourceUids: number[] = []
  const targetUids: number[] = []

  for (const row of source) {
    const { uid, modseq } = await claimUid(input.targetFolderId)
    // The body is shared, not duplicated: a copy points at the same object. The
    // retention sweep only deletes an object once no row references its key.
    const copy = await db().one<{ id: string }>(
      from(messages)
        .insert({
          folder_id: input.targetFolderId,
          address_id: row.address_id,
          uid,
          modseq,
          flags: row.flags,
          internal_date: row.internal_date,
          size: row.size,
          storage_key: row.storage_key,
          message_id: row.message_id,
          in_reply_to: row.in_reply_to,
          thread_id: row.thread_id,
          subject: row.subject,
          from_address: row.from_address,
          to_addresses: row.to_addresses,
          cc_addresses: row.cc_addresses,
          envelope: row.envelope,
          body_structure: row.body_structure,
          snippet: row.snippet,
          search_text: row.search_text,
          has_attachments: row.has_attachments,
          spam_score: row.spam_score,
        })
        .returning("id"),
    )

    // An inline body has no key to share, so it is duplicated instead.
    if (!storageEnabled() && copy) {
      await db().execute({
        text: `INSERT INTO message_blobs (message_id, data)
               SELECT $1, data FROM message_blobs WHERE message_id = $2
               ON CONFLICT (message_id) DO NOTHING`,
        values: [copy.id, row.id],
      })
    }

    sourceUids.push(num(row.uid))
    targetUids.push(num(uid))
  }

  // A copy occupies quota of its own, whether or not it shares an object.
  const bytes = source.reduce((sum, r) => sum + (r.size ?? 0), 0)
  if (bytes && source[0]) await addBytes(source[0].address_id, bytes)

  return { sourceUids, targetUids }
}

// ------------------------------------------------------------------ read --

export const folderOf = (addressId: string, name: string): Promise<Folder | null> =>
  db().one<Folder>(
    from(folders).where((q) => [q("address_id").equals(addressId), q("name").equals(name)]),
  )

export const foldersOf = (addressId: string): Promise<Folder[]> =>
  db().all<Folder>(
    from(folders)
      .where((q) => q("address_id").equals(addressId))
      .orderBy("name", "ASC"),
  )

export type FolderStatus = {
  messages: number
  recent: number
  unseen: number
  uidNext: number
  uidValidity: number
  highestModseq: number
  size: number
}

export const folderStatus = async (folder: Folder): Promise<FolderStatus> => {
  const row = await db().one<{
    total: string
    unseen: string
    recent: string
    size: string
  }>({
    text: `SELECT
             count(*)::text AS total,
             count(*) FILTER (WHERE NOT (flags @> '["\\\\Seen"]'::jsonb))::text AS unseen,
             count(*) FILTER (WHERE flags @> '["\\\\Recent"]'::jsonb)::text AS recent,
             coalesce(sum(size), 0)::text AS size
           FROM messages WHERE folder_id = $1 AND expunged_at IS NULL`,
    values: [folder.id],
  })
  return {
    messages: Number(row?.total ?? 0),
    recent: Number(row?.recent ?? 0),
    unseen: Number(row?.unseen ?? 0),
    uidNext: num(folder.uid_next),
    uidValidity: num(folder.uid_validity),
    highestModseq: num(folder.highest_modseq),
    size: Number(row?.size ?? 0),
  }
}

/** Live messages in a folder, in UID order — the order IMAP sequence numbers follow. */
export const messagesIn = (folderId: string): Promise<Message[]> =>
  db().all<Message>(
    from(messages)
      .where((q) => [q("folder_id").equals(folderId), q("expunged_at").isNull()])
      .orderBy("uid", "ASC"),
  )

export const recomputeUsage = async (addressId: string): Promise<number> => {
  const row = await db().one<{ total: string }>({
    text: `UPDATE addresses SET bytes_used = sub.total, updated_at = now()
             FROM (SELECT coalesce(sum(size), 0) AS total FROM messages
                    WHERE address_id = $1 AND expunged_at IS NULL) sub
            WHERE addresses.id = $1
        RETURNING sub.total::text AS total`,
    values: [addressId],
  })
  return Number(row?.total ?? 0)
}
