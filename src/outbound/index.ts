import { randomUUID } from "node:crypto"
import { from } from "@atlas/db"
import { allColumns, db } from "../db/index.ts"
import { type Delivery, deliveries } from "../schema/index.ts"
import { putRaw, queueKey, storageEnabled } from "../storage/index.ts"

/**
 * Putting a message on the outbound queue.
 *
 * This lives in core rather than in the SMTP package because the things that
 * need to *send* — bounces, account notifications, address recovery — are not
 * the SMTP server, and making them depend on it would make core depend on smtp
 * which already depends on core. Draining the queue still belongs to smtp,
 * since only that side needs an SMTP client.
 */

export type EnqueueInput = {
  raw: string
  mailFrom: string
  recipients: string[]
  addressId?: string | null
  domainId?: string | null
  messageId?: string | null
}

/**
 * Queued bodies when no object-storage bucket is configured.
 *
 * In-process only, so a restart drops whatever was still queued. That is an
 * accepted limitation of running without object storage — and the reason the
 * README tells a production install to configure a bucket.
 */
const inlineBodies = new Map<string, string>()

export const inlineBody = (key: string): string | null =>
  key.startsWith("inline:") ? (inlineBodies.get(key.slice(7)) ?? null) : null

/** Frees an inline body once no queue row still references it. */
export const releaseInline = async (storageKey: string | null): Promise<void> => {
  if (!storageKey?.startsWith("inline:")) return
  const row = await db().one<{ count: string }>({
    text: `SELECT count(*)::text AS count FROM deliveries
            WHERE storage_key = $1 AND status IN ('queued', 'sending', 'deferred')`,
    values: [storageKey],
  })
  if (Number(row?.count ?? 0) === 0) inlineBodies.delete(storageKey.slice(7))
}

/**
 * Writes one row per recipient. The body is stored once and shared: a message
 * to fifty recipients is one object and fifty rows, not fifty copies.
 */
export const enqueue = async (input: EnqueueInput): Promise<Delivery[]> => {
  const id = randomUUID()

  let key: string | null
  if (storageEnabled()) {
    key = await putRaw(queueKey(id), input.raw)
  } else {
    key = `inline:${id}`
    inlineBodies.set(id, input.raw)
  }

  const out: Delivery[] = []
  for (const rcpt of input.recipients) {
    const row = await db().one<Delivery>(
      from(deliveries)
        .insert({
          address_id: input.addressId ?? null,
          domain_id: input.domainId ?? null,
          storage_key: key,
          message_id: input.messageId ?? null,
          mail_from: input.mailFrom,
          rcpt_to: rcpt,
          size: input.raw.length,
        })
        .returning(...allColumns(deliveries)),
    )
    if (row) out.push(row)
  }

  return out
}
