import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { from } from "@atlas/db"
import { allColumns, db } from "../db/index.ts"
import { type Webhook, webhookEvents, webhooks } from "../schema/index.ts"

/**
 * Outbound event hooks.
 *
 * Signed with the Standard Webhooks scheme (the one Svix popularised), so the
 * verification libraries customers already have work unchanged and nobody has
 * to implement a bespoke HMAC against a prose description. The `svix-*` header
 * aliases are sent alongside the standard ones for the same reason.
 *
 * Emission is deliberately cheap and non-blocking: `emit` writes a row per
 * subscribed endpoint and returns. The worker does the delivering, so a
 * customer's slow endpoint can never hold up an SMTP transaction.
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

const base62 = (length: number): string => {
  const bytes = randomBytes(length)
  let out = ""
  for (const b of bytes) out += BASE62[b % 62]
  return out
}

/** Shaped like Svix's so existing tooling recognises it. */
export const eventId = (): string => `msg_${base62(26)}`

export const signingSecret = (): string => `whsec_${randomBytes(24).toString("base64")}`

// ------------------------------------------------------------------ types --

export const EVENT_TYPES = [
  // Inbound
  "message.received",
  "message.rejected",
  "message.spam",
  // Outbound
  "message.sent",
  "message.delivered",
  "message.deferred",
  "message.bounced",
  // Mailbox lifecycle
  "address.created",
  "address.deleted",
  "address.password_changed",
  // Administration. A grant over somebody else's mail is exactly the kind of
  // change an operator wants a record of, and webhooks are where that record
  // leaves the box.
  "admin.granted",
  "admin.revoked",
  // Domain lifecycle
  "domain.created",
  "domain.verified",
  "domain.verification_failed",
  "domain.deleted",
  // Account
  "quota.warning",
  "quota.exceeded",
  "transfer.completed",
  "transfer.failed",
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export const isEventType = (value: string): value is EventType =>
  (EVENT_TYPES as readonly string[]).includes(value)

/**
 * Matches a subscription against an event type, supporting a trailing wildcard
 * (`message.*`) and the catch-all (`*`). Customers subscribe by family far more
 * often than by individual type, and listing eight `message.` variants by hand
 * is how a subscription silently misses a new one.
 */
export const subscribes = (events: string[], type: EventType): boolean => {
  if (!events.length) return true
  return events.some((pattern) => {
    if (pattern === "*") return true
    if (pattern.endsWith(".*")) return type.startsWith(pattern.slice(0, -1))
    return pattern === type
  })
}

// ---------------------------------------------------------------- signing --

const secretKey = (secret: string): Buffer => Buffer.from(secret.replace(/^whsec_/, ""), "base64")

export const signPayload = (secret: string, id: string, timestamp: number, body: string): string =>
  `v1,${createHmac("sha256", secretKey(secret)).update(`${id}.${timestamp}.${body}`).digest("base64")}`

export const signatureHeaders = (
  secret: string,
  id: string,
  body: string,
  at: Date = new Date(),
): Record<string, string> => {
  const timestamp = Math.floor(at.getTime() / 1000)
  const signature = signPayload(secret, id, timestamp, body)
  return {
    "webhook-id": id,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signature,
    // Aliases, so a receiver using an off-the-shelf Svix verifier works with no
    // changes at all.
    "svix-id": id,
    "svix-timestamp": String(timestamp),
    "svix-signature": signature,
  }
}

/**
 * Verifies a delivery. Exported so a customer can copy it, and so the tests can
 * assert the signature is actually checkable rather than merely present.
 */
export const verifySignature = (input: {
  secret: string
  id: string
  timestamp: string
  signature: string
  body: string
  toleranceSeconds?: number
}): boolean => {
  const ts = Number(input.timestamp)
  if (!Number.isFinite(ts)) return false
  // Without the age check a captured delivery can be replayed forever.
  if (Math.abs(Date.now() / 1000 - ts) > (input.toleranceSeconds ?? 300)) return false

  const expected = signPayload(input.secret, input.id, ts, input.body)
  // A header may carry several space-separated signatures during a secret
  // rotation; any one matching is a pass.
  return input.signature.split(" ").some((candidate) => {
    const a = Buffer.from(expected)
    const b = Buffer.from(candidate.trim())
    return a.length === b.length && timingSafeEqual(a, b)
  })
}

// ------------------------------------------------------------------- emit --

export type EmitInput = {
  userId: string | null
  type: EventType
  domainId?: string | null
  data: Record<string, unknown>
}

/**
 * Records an event for every endpoint subscribed to it.
 *
 * Never throws. This is called from the SMTP and IMAP paths, where a failure to
 * record a notification must not fail the delivery that triggered it — the mail
 * is the product, the webhook is a courtesy.
 */
export const emit = async (input: EmitInput): Promise<number> => {
  if (!input.userId) return 0

  try {
    const hooks = await db().all<Webhook>(
      from(webhooks).where((q) => [
        q("user_id").equals(input.userId!),
        q("status").equals("enabled"),
      ]),
    )

    const payload = {
      type: input.type,
      // Seconds, matching the timestamp header, so a receiver correlating the
      // two is not comparing different units.
      created_at: new Date().toISOString(),
      data: input.data,
    }

    let queued = 0
    for (const hook of hooks) {
      if (hook.domain_id && hook.domain_id !== input.domainId) continue
      if (!subscribes(hook.events ?? [], input.type)) continue

      await db().execute(
        from(webhookEvents).insert({
          id: eventId(),
          user_id: input.userId,
          webhook_id: hook.id,
          type: input.type,
          payload,
        }),
      )
      queued++
    }
    return queued
  } catch (e) {
    console.error("[corsair] could not record a webhook event:", e)
    return 0
  }
}

// ------------------------------------------------------------------ hooks --

export const createWebhook = async (input: {
  userId: string
  url: string
  events: string[]
  domainId?: string | null
  description?: string | null
}): Promise<Webhook> => {
  const row = await db().one<Webhook>(
    from(webhooks)
      .insert({
        user_id: input.userId,
        url: input.url,
        events: input.events,
        domain_id: input.domainId ?? null,
        description: input.description ?? null,
        signing_secret: signingSecret(),
      })
      .returning(...allColumns(webhooks)),
  )
  return row!
}

/**
 * An endpoint that has failed this many times in a row is disabled.
 *
 * Not a courtesy to us — an endpoint that has been gone for a week is either
 * decommissioned or a customer's forgotten side project, and continuing to
 * hammer it looks exactly like an attack from the receiving end.
 */
export const FAILURE_LIMIT = 20

export const recordSuccess = async (webhookId: string): Promise<void> => {
  await db().execute(
    from(webhooks)
      .where((q) => q("id").equals(webhookId))
      .update({ consecutive_failures: 0, last_success_at: new Date(), updated_at: new Date() }),
  )
}

export const recordFailure = async (webhookId: string): Promise<boolean> => {
  const row = await db().one<{ consecutive_failures: number }>({
    text: `UPDATE webhooks SET consecutive_failures = consecutive_failures + 1,
                               updated_at = now()
            WHERE id = $1 RETURNING consecutive_failures`,
    values: [webhookId],
  })

  if ((row?.consecutive_failures ?? 0) < FAILURE_LIMIT) return false

  await db().execute(
    from(webhooks)
      .where((q) => q("id").equals(webhookId))
      .update({
        status: "disabled",
        disabled_reason: `Disabled automatically after ${FAILURE_LIMIT} consecutive failures.`,
        updated_at: new Date(),
      }),
  )
  return true
}
