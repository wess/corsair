import { from } from "@atlas/db"
import { db } from "../../db/index.ts"
import { recordFailure, recordSuccess, signatureHeaders } from "../../events/index.ts"
import {
  type Webhook,
  type WebhookEvent,
  webhookAttempts,
  webhookEvents,
  webhooks,
} from "../../schema/index.ts"

/**
 * Delivering event hooks.
 *
 * Retries on the Svix schedule: a few fast attempts for an endpoint that was
 * briefly restarting, then widening out over about a day. Longer than that is
 * not useful — an event describing a message received yesterday is of no help
 * to anyone, and holding it costs a row and a wakeup.
 */

const MAX_ATTEMPTS = 8
const TIMEOUT_MS = 10_000
const BACKOFF_SECONDS = [5, 30, 300, 1800, 7200, 18_000, 36_000, 86_400]

export type DeliveryResult = {
  status: "delivered" | "retrying" | "exhausted" | "skipped"
  detail: string
}

export const deliverEvent = async (eventId: string): Promise<DeliveryResult> => {
  const event = await db().one<WebhookEvent>(
    from(webhookEvents).where((q) => q("id").equals(eventId)),
  )
  if (!event) return { status: "skipped", detail: "event no longer exists" }
  if (event.status === "delivered") return { status: "delivered", detail: "already delivered" }

  const hook = await db().one<Webhook>(
    from(webhooks).where((q) => q("id").equals(event.webhook_id)),
  )
  if (!hook) return { status: "skipped", detail: "endpoint removed" }

  if (hook.status !== "enabled") {
    await db().execute(
      from(webhookEvents)
        .where((q) => q("id").equals(event.id))
        .update({ status: "failed", next_attempt_at: null }),
    )
    return { status: "exhausted", detail: "endpoint disabled" }
  }

  const body = JSON.stringify(event.payload)
  const started = performance.now()
  let statusCode: number | null = null
  let response: string | null = null
  let error: string | null = null

  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "Corsair-Webhook/1.0",
        ...signatureHeaders(hook.signing_secret, event.id, body),
      },
      body,
      // A customer endpoint that hangs must not hold a worker slot. Ten seconds
      // is generous for something that should only be acknowledging receipt.
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    statusCode = res.status
    // Truncated: the panel shows this to help debugging, and an endpoint that
    // answers with a megabyte of HTML should not put a megabyte in the database.
    response = (await res.text()).slice(0, 2000)
  } catch (e) {
    error = (e as Error).message
  }

  const attempts = event.attempts + 1
  const ok = statusCode !== null && statusCode >= 200 && statusCode < 300

  await db().execute(
    from(webhookAttempts).insert({
      webhook_event_id: event.id,
      webhook_id: hook.id,
      http_status_code: statusCode,
      response,
      error,
      duration_ms: Math.round(performance.now() - started),
    }),
  )

  if (ok) {
    await db().execute(
      from(webhookEvents)
        .where((q) => q("id").equals(event.id))
        .update({
          status: "delivered",
          attempts,
          delivered_at: new Date(),
          next_attempt_at: null,
        }),
    )
    await recordSuccess(hook.id)
    return { status: "delivered", detail: `HTTP ${statusCode}` }
  }

  const detail = error ?? `HTTP ${statusCode}`

  if (attempts >= MAX_ATTEMPTS) {
    await db().execute(
      from(webhookEvents)
        .where((q) => q("id").equals(event.id))
        .update({ status: "exhausted", attempts, next_attempt_at: null }),
    )
    const disabled = await recordFailure(hook.id)
    return {
      status: "exhausted",
      detail: disabled ? `${detail}; endpoint disabled after repeated failure` : detail,
    }
  }

  const delay = BACKOFF_SECONDS[attempts - 1] ?? 86_400
  await db().execute(
    from(webhookEvents)
      .where((q) => q("id").equals(event.id))
      .update({
        status: "pending",
        attempts,
        next_attempt_at: new Date(Date.now() + delay * 1000),
      }),
  )
  return { status: "retrying", detail: `${detail}; retrying in ${delay}s` }
}

/**
 * Claims a batch of due events.
 *
 * `FOR UPDATE SKIP LOCKED` for the same reason the mail queue uses it: several
 * workers can drain this without coordinating and without any event being
 * delivered twice.
 */
export const drainWebhooks = async (limit = 16): Promise<{ attempted: number }> => {
  const rows = await db().all<{ id: string }>({
    text: `UPDATE webhook_events SET status = 'sending'
            WHERE id IN (
              SELECT id FROM webhook_events
               WHERE status = 'pending' AND next_attempt_at <= now()
               ORDER BY next_attempt_at
               LIMIT $1
               FOR UPDATE SKIP LOCKED
            )
        RETURNING id`,
    values: [limit],
  })

  await Promise.all(
    rows.map((row) =>
      deliverEvent(row.id).catch((e) => console.error(`[corsair] webhook ${row.id} failed:`, e)),
    ),
  )
  return { attempted: rows.length }
}

/** Re-queues an event for immediate delivery — the panel's replay button. */
export const replayEvent = async (eventId: string): Promise<void> => {
  await db().execute(
    from(webhookEvents)
      .where((q) => q("id").equals(eventId))
      .update({ status: "pending", attempts: 0, next_attempt_at: new Date() }),
  )
}

/** Events a worker took and then died holding. */
export const releaseStaleWebhooks = async (olderThanMinutes = 15): Promise<number> => {
  const rows = await db().all<{ id: string }>({
    text: `UPDATE webhook_events SET status = 'pending'
            WHERE status = 'sending' AND created_at < now() - ($1 || ' minutes')::interval
        RETURNING id`,
    values: [String(olderThanMinutes)],
  })
  return rows.length
}
