import { from } from "@atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { config } from "../../../config/index.ts"
import { allColumns, db } from "../../../db/index.ts"
import { conflict, invalidParameter, notFound } from "../../../errors/index.ts"
import {
  createWebhook,
  EVENT_TYPES,
  isEventType,
  eventId as makeEventId,
  signatureHeaders,
  signingSecret,
} from "../../../events/index.ts"
import { paginate, parsePageQuery } from "../../../pagination/index.ts"
import {
  type Webhook,
  type WebhookAttempt,
  type WebhookEvent,
  webhookAttempts,
  webhookEvents,
  webhooks,
} from "../../../schema/index.ts"
import { authed, principalOf } from "../../pipes/index.ts"

/**
 * Managing outbound event hooks.
 *
 * The signing secret is returned in full on creation and never again — it is a
 * credential, and an endpoint that has lost it should rotate rather than read
 * it back. Listing shows only a prefix, which is enough to tell two apart.
 */

const hookParam = z.object({ webhook_id: z.string().uuid() })

const owned = async (userId: string, id: string): Promise<Webhook> => {
  const row = await db().one<Webhook>(
    from(webhooks).where((q) => [q("id").equals(id), q("user_id").equals(userId)]),
  )
  if (!row) throw notFound("Webhook not found.")
  return row
}

const hookObject = (hook: Webhook, secret?: string) => ({
  object: "webhook" as const,
  id: hook.id,
  url: hook.url,
  description: hook.description,
  events: hook.events ?? [],
  domain_id: hook.domain_id,
  status: hook.status,
  disabled_reason: hook.disabled_reason,
  consecutive_failures: hook.consecutive_failures,
  last_success_at: hook.last_success_at?.toISOString() ?? null,
  // Full value only at creation and rotation; a prefix thereafter.
  signing_secret: secret ?? `${hook.signing_secret.slice(0, 12)}…`,
  created_at: hook.created_at.toISOString(),
})

const eventObject = (event: WebhookEvent) => ({
  object: "webhook_event" as const,
  id: event.id,
  webhook_id: event.webhook_id,
  type: event.type,
  status: event.status,
  attempts: event.attempts,
  next_attempt_at: event.next_attempt_at?.toISOString() ?? null,
  delivered_at: event.delivered_at?.toISOString() ?? null,
  created_at: event.created_at.toISOString(),
  payload: event.payload,
})

/**
 * Rejects anything that is not a plain HTTPS URL to a public host.
 *
 * An endpoint pointing at localhost or a link-local address turns this into a
 * server-side request forgery primitive: the customer supplies the URL and the
 * server fetches it from inside the network. Refusing at creation is far better
 * than discovering it in an outbound proxy log.
 */
const assertDeliverable = (raw: string): string => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw invalidParameter("That is not a valid URL.")
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw invalidParameter("A webhook URL has to be http or https.")
  }

  const host = url.hostname.toLowerCase()
  const blocked =
    host === "localhost" ||
    host === "0.0.0.0" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "[::1]" ||
    host.startsWith("[fd") ||
    host.startsWith("[fe80")

  // An operator whose consumers live on the same private network can opt in;
  // it is off by default because the safe case is the rarer one.
  if (blocked && !config.webhookAllowPrivate) {
    throw invalidParameter(
      "That address is on a private or loopback network. A webhook has to point somewhere this server can reach from the public internet.",
    )
  }
  return url.toString()
}

const validateEvents = (events: string[]): string[] => {
  for (const pattern of events) {
    if (pattern === "*" || pattern.endsWith(".*")) continue
    if (!isEventType(pattern)) {
      throw invalidParameter(
        `"${pattern}" is not an event type. Use one of ${EVENT_TYPES.join(", ")}, a family wildcard like "message.*", or "*".`,
      )
    }
  }
  return events
}

export const hookRoutes: Route[] = [
  /** The catalogue, so a client can populate a picker without hard-coding it. */
  getR("/api/webhooks/events", { before: authed, assigns: {} as never }, async (c) =>
    json(c, 200, {
      object: "list",
      data: EVENT_TYPES.map((type) => ({ type, family: type.split(".")[0] })),
    }),
  ),

  getR("/api/webhooks", { before: authed, assigns: {} as never }, async (c) => {
    const page = await paginate<Webhook>({
      source: "webhooks",
      columns: "*",
      where: "user_id = $1",
      values: [principalOf(c).userId],
      searchColumns: ["url", "description"],
      sortable: { url: "url", status: "status", created: "created_at" },
      defaultSort: "created_at",
      query: parsePageQuery((c.query ?? {}) as Record<string, string>),
    })
    return json(c, 200, { ...page, data: page.data.map((h) => hookObject(h)) })
  }),

  postR(
    "/api/webhooks",
    {
      body: z.object({
        url: z.string().max(2000),
        events: z.array(z.string().max(64)).max(64).optional(),
        domain_id: z.string().uuid().nullable().optional(),
        description: z.string().max(200).nullable().optional(),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const url = assertDeliverable(c.body.url)
      const events = validateEvents(c.body.events ?? ["*"])

      if (c.body.domain_id) {
        const domain = await db().one<{ id: string }>({
          text: "SELECT id FROM domains WHERE id = $1 AND user_id = $2",
          values: [c.body.domain_id, principalOf(c).userId],
        })
        if (!domain) throw invalidParameter("That domain is not on this account.")
      }

      const hook = await createWebhook({
        userId: principalOf(c).userId,
        url,
        events,
        domainId: c.body.domain_id ?? null,
        description: c.body.description ?? null,
      })

      // The only time the secret is returned in full.
      return json(c, 201, hookObject(hook, hook.signing_secret))
    },
  ),

  getR(
    "/api/webhooks/:webhook_id",
    { params: hookParam, before: authed, assigns: {} as never },
    async (c) => json(c, 200, hookObject(await owned(principalOf(c).userId, c.params.webhook_id))),
  ),

  patchR(
    "/api/webhooks/:webhook_id",
    {
      params: hookParam,
      body: z.object({
        url: z.string().max(2000).optional(),
        events: z.array(z.string().max(64)).max(64).optional(),
        description: z.string().max(200).nullable().optional(),
        status: z.enum(["enabled", "disabled"]).optional(),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const hook = await owned(principalOf(c).userId, c.params.webhook_id)
      const patch: Record<string, unknown> = { updated_at: new Date() }

      if (c.body.url !== undefined) patch.url = assertDeliverable(c.body.url)
      if (c.body.events !== undefined) patch.events = validateEvents(c.body.events)
      if (c.body.description !== undefined) patch.description = c.body.description
      if (c.body.status !== undefined) {
        patch.status = c.body.status
        // Re-enabling clears the automatic-disable state, so the endpoint gets a
        // fresh run of attempts rather than being switched straight back off.
        if (c.body.status === "enabled") {
          patch.disabled_reason = null
          patch.consecutive_failures = 0
        }
      }

      const saved = await db().one<Webhook>(
        from(webhooks)
          .where((q) => q("id").equals(hook.id))
          .update(patch)
          .returning(...allColumns(webhooks)),
      )
      return json(c, 200, hookObject(saved!))
    },
  ),

  /** Rotates the signing secret, returning the new one once. */
  postR(
    "/api/webhooks/:webhook_id/rotate",
    { params: hookParam, before: authed, assigns: {} as never },
    async (c) => {
      const hook = await owned(principalOf(c).userId, c.params.webhook_id)
      const secret = signingSecret()
      const saved = await db().one<Webhook>(
        from(webhooks)
          .where((q) => q("id").equals(hook.id))
          .update({ signing_secret: secret, updated_at: new Date() })
          .returning(...allColumns(webhooks)),
      )
      return json(c, 200, hookObject(saved!, secret))
    },
  ),

  /**
   * Sends a signed test delivery immediately, synchronously, and reports what
   * came back. The point is to let somebody wiring up an endpoint see the exact
   * failure now rather than in a delivery log in ten minutes.
   */
  postR(
    "/api/webhooks/:webhook_id/test",
    { params: hookParam, before: authed, assigns: {} as never },
    async (c) => {
      const hook = await owned(principalOf(c).userId, c.params.webhook_id)
      const id = makeEventId()
      const body = JSON.stringify({
        type: "message.received",
        created_at: new Date().toISOString(),
        data: {
          test: true,
          recipient: "someone@example.com",
          sender: "sender@example.net",
          subject: "A test delivery from Corsair",
          message_id: "<test@corsair>",
        },
      })

      const started = performance.now()
      try {
        const res = await fetch(hook.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "Corsair-Webhook/1.0",
            ...signatureHeaders(hook.signing_secret, id, body),
          },
          body,
          signal: AbortSignal.timeout(10_000),
        })
        return json(c, 200, {
          object: "webhook_test",
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          duration_ms: Math.round(performance.now() - started),
          response: (await res.text()).slice(0, 2000),
        })
      } catch (e) {
        return json(c, 200, {
          object: "webhook_test",
          ok: false,
          status: null,
          duration_ms: Math.round(performance.now() - started),
          error: (e as Error).message,
        })
      }
    },
  ),

  getR(
    "/api/webhooks/:webhook_id/events",
    { params: hookParam, before: authed, assigns: {} as never },
    async (c) => {
      const hook = await owned(principalOf(c).userId, c.params.webhook_id)
      const page = await paginate<WebhookEvent>({
        source: "webhook_events",
        columns: "*",
        where: "webhook_id = $1",
        values: [hook.id],
        searchColumns: ["type", "id"],
        sortable: { type: "type", status: "status", created: "created_at" },
        defaultSort: "created_at",
        query: {
          ...parsePageQuery((c.query ?? {}) as Record<string, string>),
          direction:
            ((c.query ?? {}) as Record<string, string>).direction === "asc" ? "asc" : "desc",
        },
      })
      return json(c, 200, { ...page, data: page.data.map(eventObject) })
    },
  ),

  /** Every attempt for one event — the status and body the endpoint returned. */
  getR(
    "/api/webhooks/:webhook_id/events/:event_id",
    {
      params: z.object({ webhook_id: z.string().uuid(), event_id: z.string().max(64) }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const hook = await owned(principalOf(c).userId, c.params.webhook_id)
      const event = await db().one<WebhookEvent>(
        from(webhookEvents).where((q) => [
          q("id").equals(c.params.event_id),
          q("webhook_id").equals(hook.id),
        ]),
      )
      if (!event) throw notFound("Event not found.")

      const attempts = await db().all<WebhookAttempt>(
        from(webhookAttempts)
          .where((q) => q("webhook_event_id").equals(event.id))
          .orderBy("sent_at", "DESC"),
      )

      return json(c, 200, {
        ...eventObject(event),
        attempts: attempts.map((a) => ({
          id: a.id,
          http_status_code: a.http_status_code,
          response: a.response,
          error: a.error,
          duration_ms: a.duration_ms,
          sent_at: a.sent_at.toISOString(),
        })),
      })
    },
  ),

  postR(
    "/api/webhooks/:webhook_id/events/:event_id/replay",
    {
      params: z.object({ webhook_id: z.string().uuid(), event_id: z.string().max(64) }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const hook = await owned(principalOf(c).userId, c.params.webhook_id)
      if (hook.status !== "enabled") {
        throw conflict("Enable this endpoint before replaying to it.")
      }
      const event = await db().one<WebhookEvent>(
        from(webhookEvents).where((q) => [
          q("id").equals(c.params.event_id),
          q("webhook_id").equals(hook.id),
        ]),
      )
      if (!event) throw notFound("Event not found.")

      const { replayEvent } = await import("../../../worker/webhook/index.ts")
      await replayEvent(event.id)
      return json(c, 202, { object: "webhook_event", id: event.id, replaying: true })
    },
  ),

  delR(
    "/api/webhooks/:webhook_id",
    { params: hookParam, before: authed, assigns: {} as never },
    async (c) => {
      const hook = await owned(principalOf(c).userId, c.params.webhook_id)
      await db().execute(
        from(webhooks)
          .where((q) => q("id").equals(hook.id))
          .del(),
      )
      return json(c, 200, { object: "webhook", id: hook.id, deleted: true })
    },
  ),
]
