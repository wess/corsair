import { from } from "@atlas/db"
import { createStore, download, remove, type Store, upload } from "@atlas/storage"
import { config } from "../config/index.ts"
import { db } from "../db/index.ts"
import { messageBlobs } from "../schema/index.ts"

/**
 * Where raw MIME lives.
 *
 * With a bucket configured, message bodies go to S3-compatible object storage
 * (DigitalOcean Spaces) and Postgres holds only the key. Without one they stay
 * inline in `message_blobs`, which keeps a single-container install working
 * with nothing but a database — at the cost of putting mail volume in the WAL.
 *
 * Objects are written with no ACL, so they inherit the bucket's default of
 * private. Mail must never be publicly readable, and a signed GET is the only
 * way anything reads it back.
 */
let store: Store | null = null

export const objectStore = (): Store | null => {
  if (!config.storage.bucket) return null
  if (!store) {
    store = createStore({
      endpoint: config.storage.endpoint || `https://s3.${config.storage.region}.amazonaws.com`,
      bucket: config.storage.bucket,
      accessKey: config.storage.accessKeyId,
      secretKey: config.storage.secretAccessKey,
      region: config.storage.region,
    })
  }
  return store
}

export const storageEnabled = (): boolean => objectStore() !== null

/**
 * Keys are date-sharded under the address id. Object stores do not have
 * directories, but every console and every lifecycle rule pretends they do, and
 * a flat namespace of millions of UUIDs is unusable in both.
 */
export const messageKey = (addressId: string, messageId: string, at = new Date()): string => {
  const y = at.getUTCFullYear()
  const m = String(at.getUTCMonth() + 1).padStart(2, "0")
  const d = String(at.getUTCDate()).padStart(2, "0")
  return `${config.storage.prefix}/messages/${addressId}/${y}/${m}/${d}/${messageId}.eml`
}

export const queueKey = (id: string): string => `${config.storage.prefix}/queue/${id}.eml`

/**
 * Writes raw MIME and returns the key to store on the row, or null when the
 * body went inline. A null key is the caller's signal to read from
 * `message_blobs` instead.
 */
export const putRaw = async (key: string, raw: string): Promise<string | null> => {
  const s = objectStore()
  if (!s) return null
  await upload(s, { key, body: raw, contentType: "message/rfc822" })
  return key
}

export const putInline = async (messageId: string, raw: string): Promise<void> => {
  await db().execute(from(messageBlobs).insert({ message_id: messageId, data: raw }))
}

export const getRaw = async (input: {
  storageKey: string | null
  messageId?: string | null
}): Promise<string | null> => {
  if (input.storageKey) {
    const s = objectStore()
    if (!s) return null
    try {
      const response = await download(s, input.storageKey)
      // latin1, not UTF-8: the rest of the pipeline counts octets, and decoding
      // as UTF-8 here would silently change every offset. See core/mime.
      return Buffer.from(await response.arrayBuffer()).toString("latin1")
    } catch {
      // A missing object is a real state — a body deleted out from under a row
      // — not an exception the caller can do anything with.
      return null
    }
  }
  if (!input.messageId) return null
  const row = await db().one<{ data: string }>(
    from(messageBlobs)
      .select("data")
      .where((q) => q("message_id").equals(input.messageId!)),
  )
  return row?.data ?? null
}

/**
 * Deleting the body is best-effort on purpose. A message row is gone from the
 * user's mailbox the moment it is expunged; failing the whole expunge because
 * the bucket was briefly unreachable would leave the mailbox in a worse state
 * than an orphaned object does. The retention sweep collects the strays.
 */
export const deleteRaw = async (storageKey: string | null): Promise<void> => {
  if (!storageKey) return
  const s = objectStore()
  if (!s) return
  try {
    await remove(s, storageKey)
  } catch (e) {
    console.error("[corsair] failed to delete object", storageKey, e)
  }
}
