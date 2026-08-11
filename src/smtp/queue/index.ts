import { randomUUID } from "node:crypto"
import { from } from "@atlas/db"
import { ownerOfDomain } from "../../addresses/index.ts"
import { config } from "../../config/index.ts"
import { db } from "../../db/index.ts"
import { emit } from "../../events/index.ts"
import { inlineBody, releaseInline } from "../../outbound/index.ts"
import { type Delivery, deliveries } from "../../schema/index.ts"
import { getRaw } from "../../storage/index.ts"
import { deliverToDomain } from "../client/index.ts"

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`

/**
 * Retry schedule, in minutes. Roughly Postfix's shape: a few quick attempts for
 * a server that is briefly down, then widening gaps out to about five days.
 * Giving up sooner than that loses mail to maintenance windows; giving up later
 * means a recipient who has actually gone away sits in the queue forever.
 */
const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240, 480, 960, 1440, 2880, 4320]

const backoffFor = (attempt: number): Date => {
  const minutes = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)] ?? 4320
  // Jitter keeps a burst of deferrals from the same outage retrying in lockstep.
  const jitter = 1 + (Math.random() * 0.2 - 0.1)
  return new Date(Date.now() + minutes * 60_000 * jitter)
}

const bodyOf = async (row: Delivery): Promise<string | null> => {
  if (row.storage_key?.startsWith("inline:")) return inlineBody(row.storage_key)
  return getRaw({ storageKey: row.storage_key })
}

/**
 * Claims a batch of due rows.
 *
 * `FOR UPDATE SKIP LOCKED` is what makes several workers safe against each
 * other: each takes rows nobody else holds, with no coordination and no chance
 * of two workers delivering the same message twice.
 */
const claim = async (limit: number): Promise<Delivery[]> =>
  db().all<Delivery>({
    text: `UPDATE deliveries SET status = 'sending', locked_at = now(), locked_by = $1,
                                 attempts = attempts + 1, updated_at = now()
            WHERE id IN (
              SELECT id FROM deliveries
               WHERE status IN ('queued', 'deferred') AND run_at <= now()
               ORDER BY run_at
               LIMIT $2
               FOR UPDATE SKIP LOCKED
            )
        RETURNING *`,
    values: [WORKER_ID, limit],
  })

export type DrainResult = { attempted: number; sent: number; deferred: number; failed: number }

export const drain = async (limit = config.worker.concurrency): Promise<DrainResult> => {
  const rows = await claim(limit)
  const result: DrainResult = { attempted: rows.length, sent: 0, deferred: 0, failed: 0 }
  if (!rows.length) return result

  await Promise.all(
    rows.map(async (row) => {
      const raw = await bodyOf(row)
      if (!raw) {
        await fail(row, 550, "The queued message body is no longer available.")
        result.failed++
        return
      }

      const at = row.rcpt_to.lastIndexOf("@")
      const domain = at === -1 ? "" : row.rcpt_to.slice(at + 1)
      const outcome = await deliverToDomain({
        domain,
        mailFrom: row.mail_from,
        rcptTo: row.rcpt_to,
        raw,
      })

      if (outcome.ok) {
        await db().execute(
          from(deliveries)
            .where((q) => q("id").equals(row.id))
            .update({
              status: "sent",
              sent_at: new Date(),
              last_code: outcome.code,
              last_error: null,
              next_hop: outcome.host,
              locked_at: null,
              locked_by: null,
              updated_at: new Date(),
            }),
        )
        await releaseInline(row.storage_key)
        void notify(row, "message.delivered", { code: outcome.code, host: outcome.host })
        result.sent++
        return
      }

      if (outcome.retryable && row.attempts < row.max_attempts) {
        await db().execute(
          from(deliveries)
            .where((q) => q("id").equals(row.id))
            .update({
              status: "deferred",
              run_at: backoffFor(row.attempts),
              last_code: outcome.code,
              last_error: outcome.message.slice(0, 2000),
              next_hop: outcome.host,
              locked_at: null,
              locked_by: null,
              updated_at: new Date(),
            }),
        )
        void notify(row, "message.deferred", {
          code: outcome.code,
          reason: outcome.message.slice(0, 500),
          attempt: row.attempts,
        })
        result.deferred++
        return
      }

      await fail(row, outcome.code, outcome.message)
      await releaseInline(row.storage_key)
      void notify(row, "message.bounced", {
        code: outcome.code,
        reason: outcome.message.slice(0, 500),
      })
      result.failed++
    }),
  )

  return result
}

/**
 * Emits a delivery-state event for the account that owns the sending domain.
 *
 * Resolved per event rather than carried on the row: a delivery may outlive the
 * address it was sent from, and the owner is the thing the hook belongs to.
 */
const notify = async (
  row: Delivery,
  type: "message.delivered" | "message.deferred" | "message.bounced",
  data: Record<string, unknown>,
): Promise<void> => {
  if (!row.domain_id) return
  const owner = await ownerOfDomain(row.domain_id).catch(() => null)
  if (!owner) return
  await emit({
    userId: owner,
    domainId: row.domain_id,
    type,
    data: { recipient: row.rcpt_to, sender: row.mail_from, message_id: row.message_id, ...data },
  })
}

const fail = async (row: Delivery, code: number, message: string): Promise<void> => {
  await db().execute(
    from(deliveries)
      .where((q) => q("id").equals(row.id))
      .update({
        status: "failed",
        last_code: code,
        last_error: message.slice(0, 2000),
        locked_at: null,
        locked_by: null,
        updated_at: new Date(),
      }),
  )
}

/** Rows a worker took and then died holding, returned to the queue. */
export const releaseStale = async (olderThanMinutes = 15): Promise<number> => {
  const rows = await db().all<{ id: string }>({
    text: `UPDATE deliveries SET status = 'deferred', locked_at = NULL, locked_by = NULL
            WHERE status = 'sending' AND locked_at < now() - ($1 || ' minutes')::interval
        RETURNING id`,
    values: [String(olderThanMinutes)],
  })
  return rows.length
}
