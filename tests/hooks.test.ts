import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db } from "../src/db/index.ts"
import { createWebhook, emit, FAILURE_LIMIT, verifySignature } from "../src/events/index.ts"
import {
  type Domain,
  users,
  type Webhook,
  type WebhookEvent,
  webhookEvents,
  webhooks,
} from "../src/schema/index.ts"
import { deliverEvent, drainWebhooks } from "../src/worker/webhook/index.ts"

/**
 * The delivery pipeline against a real receiver: emission, signing, retry, and
 * the automatic disable. The API-layer guards are covered in `smoke.ts`; this
 * is the part that only fails against a real socket.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
let userId = ""
let domainA: Domain
let domainB: Domain

type Received = { headers: Record<string, string>; body: string }

const received: Received[] = []
let failures = 0
let server: ReturnType<typeof Bun.serve>
let url = ""

const eventsFor = (hookId: string) =>
  db().all<WebhookEvent>(
    from(webhookEvents)
      .where((q) => q("webhook_id").equals(hookId))
      .orderBy("created_at", "ASC"),
  )

const hookFor = (id: string) => db().one<Webhook>(from(webhooks).where((q) => q("id").equals(id)))

beforeAll(async () => {
  const user = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Hooks', $2) RETURNING id`,
    values: [`hooks-${suffix}@corsair.test`, `h${suffix}`],
  })
  userId = user!.id

  const makeDomain = async (name: string) =>
    (await db().one<Domain>({
      text: `INSERT INTO domains (user_id, name, verification_token, status)
             VALUES ($1, $2, 'mail-host-verify=hooks', 'active') RETURNING *`,
      values: [userId, name],
    }))!
  domainA = await makeDomain(`hooks-a-${suffix}.invalid`)
  domainB = await makeDomain(`hooks-b-${suffix}.invalid`)

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      received.push({ headers: Object.fromEntries(req.headers.entries()), body })
      if (failures > 0) {
        failures--
        return new Response("not today", { status: 500 })
      }
      return new Response("ok")
    },
  })
  url = `http://127.0.0.1:${server.port}/hook`
})

afterAll(async () => {
  server?.stop(true)
  await db().execute(
    from(users)
      .where((q) => q("id").equals(userId))
      .del(),
  )
})

describe("emission", () => {
  test("queues one event per subscribed endpoint", async () => {
    const a = await createWebhook({ userId, url, events: ["message.received"] })
    const b = await createWebhook({ userId, url, events: ["message.received"] })
    const c = await createWebhook({ userId, url, events: ["domain.verified"] })

    const queued = await emit({
      userId,
      type: "message.received",
      data: { recipient: "a@b.test" },
    })

    expect(queued).toBe(2)
    expect(await eventsFor(a.id)).toHaveLength(1)
    expect(await eventsFor(b.id)).toHaveLength(1)
    expect(await eventsFor(c.id)).toHaveLength(0)
  })

  test("a family wildcard receives every member", async () => {
    const hook = await createWebhook({ userId, url, events: ["message.*"] })
    await emit({ userId, type: "message.bounced", data: {} })
    await emit({ userId, type: "message.delivered", data: {} })
    await emit({ userId, type: "domain.verified", data: {} })

    const types = (await eventsFor(hook.id)).map((e) => e.type)
    expect(types).toEqual(["message.bounced", "message.delivered"])
  })

  test("a domain-scoped endpoint only receives its own domain", async () => {
    const hook = await createWebhook({
      userId,
      url,
      events: ["*"],
      domainId: domainA.id,
    })
    await emit({ userId, type: "message.received", domainId: domainB.id, data: {} })
    expect(await eventsFor(hook.id)).toHaveLength(0)

    await emit({ userId, type: "message.received", domainId: domainA.id, data: {} })
    expect(await eventsFor(hook.id)).toHaveLength(1)
  })

  test("a disabled endpoint receives nothing", async () => {
    const hook = await createWebhook({ userId, url, events: ["*"] })
    await db().execute(
      from(webhooks)
        .where((q) => q("id").equals(hook.id))
        .update({ status: "disabled" }),
    )
    await emit({ userId, type: "message.received", data: {} })
    expect(await eventsFor(hook.id)).toHaveLength(0)
  })

  test("emission never throws, whatever it is given", async () => {
    // Called from the SMTP path, where a failure to notify must never fail the
    // delivery that triggered it.
    expect(await emit({ userId: null, type: "message.received", data: {} })).toBe(0)
    expect(await emit({ userId: "not-a-uuid", type: "message.received", data: {} })).toBe(0)
  })
})

describe("delivery", () => {
  test("posts a signed, verifiable payload", async () => {
    received.length = 0
    const hook = await createWebhook({ userId, url, events: ["domain.created"] })
    await emit({ userId, type: "domain.created", data: { domain: "example.test" } })

    const [event] = await eventsFor(hook.id)
    const result = await deliverEvent(event!.id)
    expect(result.status).toBe("delivered")
    expect(received).toHaveLength(1)

    const delivery = received[0]!
    const fresh = await hookFor(hook.id)
    expect(
      verifySignature({
        secret: fresh!.signing_secret,
        id: delivery.headers["webhook-id"]!,
        timestamp: delivery.headers["webhook-timestamp"]!,
        signature: delivery.headers["webhook-signature"]!,
        body: delivery.body,
      }),
    ).toBe(true)

    const payload = JSON.parse(delivery.body)
    expect(payload.type).toBe("domain.created")
    expect(payload.data.domain).toBe("example.test")
    expect(delivery.headers["webhook-id"]).toBe(event!.id)
  })

  test("the id in the header is the idempotency key a receiver can dedupe on", async () => {
    received.length = 0
    const hook = await createWebhook({ userId, url, events: ["domain.created"] })
    await emit({ userId, type: "domain.created", data: {} })
    const [event] = await eventsFor(hook.id)

    await deliverEvent(event!.id)
    // A second delivery of an already-delivered event is a no-op rather than a
    // duplicate POST.
    const again = await deliverEvent(event!.id)
    expect(again.status).toBe("delivered")
    expect(again.detail).toContain("already")
    expect(received).toHaveLength(1)
  })

  test("a failure is retried with a later attempt time", async () => {
    received.length = 0
    failures = 1
    const hook = await createWebhook({ userId, url, events: ["domain.created"] })
    await emit({ userId, type: "domain.created", data: {} })
    const [event] = await eventsFor(hook.id)

    const first = await deliverEvent(event!.id)
    expect(first.status).toBe("retrying")

    const after = (await eventsFor(hook.id))[0]!
    expect(after.status).toBe("pending")
    expect(after.attempts).toBe(1)
    expect(after.next_attempt_at!.getTime()).toBeGreaterThan(Date.now())

    // The retry succeeds, because the receiver only failed once.
    await db().execute(
      from(webhookEvents)
        .where((q) => q("id").equals(event!.id))
        .update({ next_attempt_at: new Date(Date.now() - 1000) }),
    )
    const second = await deliverEvent(event!.id)
    expect(second.status).toBe("delivered")
    expect(received).toHaveLength(2)
  })

  test("every attempt is recorded with its status and body", async () => {
    failures = 1
    const hook = await createWebhook({ userId, url, events: ["domain.created"] })
    await emit({ userId, type: "domain.created", data: {} })
    const [event] = await eventsFor(hook.id)

    await deliverEvent(event!.id)
    await deliverEvent(event!.id)

    const attempts = await db().all<{ http_status_code: number; response: string }>({
      text: "SELECT http_status_code, response FROM webhook_attempts WHERE webhook_event_id = $1 ORDER BY sent_at",
      values: [event!.id],
    })
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.http_status_code).toBe(500)
    expect(attempts[0]!.response).toContain("not today")
    expect(attempts[1]!.http_status_code).toBe(200)
  })

  test("an unreachable endpoint is an error, not a crash", async () => {
    const hook = await createWebhook({
      userId,
      // Nothing is listening here.
      url: "http://127.0.0.1:1/hook",
      events: ["domain.created"],
    })
    await emit({ userId, type: "domain.created", data: {} })
    const [event] = await eventsFor(hook.id)

    const result = await deliverEvent(event!.id)
    expect(result.status).toBe("retrying")

    const attempt = await db().one<{ error: string | null }>({
      text: "SELECT error FROM webhook_attempts WHERE webhook_event_id = $1",
      values: [event!.id],
    })
    expect(attempt?.error).toBeTruthy()
  })

  test("a removed endpoint stops delivery rather than erroring forever", async () => {
    const hook = await createWebhook({ userId, url, events: ["domain.created"] })
    await emit({ userId, type: "domain.created", data: {} })
    const [event] = await eventsFor(hook.id)

    await db().execute(
      from(webhooks)
        .where((q) => q("id").equals(hook.id))
        .del(),
    )
    const result = await deliverEvent(event!.id)
    expect(result.status).toBe("skipped")
  })
})

describe("automatic disable", () => {
  test("an endpoint that keeps failing is switched off", async () => {
    const hook = await createWebhook({
      userId,
      url: "http://127.0.0.1:1/gone",
      events: ["domain.created"],
    })

    // Drive the failure counter straight to the threshold rather than making
    // FAILURE_LIMIT real HTTP attempts.
    await db().execute(
      from(webhooks)
        .where((q) => q("id").equals(hook.id))
        .update({ consecutive_failures: FAILURE_LIMIT - 1 }),
    )

    await emit({ userId, type: "domain.created", data: {} })
    const [event] = await eventsFor(hook.id)
    await db().execute(
      from(webhookEvents)
        .where((q) => q("id").equals(event!.id))
        .update({ attempts: 7 }),
    )

    const result = await deliverEvent(event!.id)
    expect(result.status).toBe("exhausted")

    const after = await hookFor(hook.id)
    expect(after?.status).toBe("disabled")
    expect(after?.disabled_reason).toContain("consecutive failures")
  })

  test("a success resets the failure counter", async () => {
    const hook = await createWebhook({ userId, url, events: ["domain.created"] })
    await db().execute(
      from(webhooks)
        .where((q) => q("id").equals(hook.id))
        .update({ consecutive_failures: 5 }),
    )

    await emit({ userId, type: "domain.created", data: {} })
    const [event] = await eventsFor(hook.id)
    await deliverEvent(event!.id)

    const after = await hookFor(hook.id)
    expect(after?.consecutive_failures).toBe(0)
    expect(after?.last_success_at).toBeTruthy()
  })
})

describe("draining", () => {
  test("the worker claims and delivers due events", async () => {
    received.length = 0
    // Earlier tests deliberately left events pointing at a dead port; a drain
    // would pick those up too and this test would be measuring them.
    await db().execute({
      text: `UPDATE webhook_events SET status = 'delivered'
              WHERE status = 'pending' AND user_id = $1`,
      values: [userId],
    })

    const hook = await createWebhook({ userId, url, events: ["quota.warning"] })
    for (let i = 0; i < 3; i++) {
      await emit({ userId, type: "quota.warning", data: { n: i } })
    }

    const result = await drainWebhooks(50)
    expect(result.attempted).toBeGreaterThanOrEqual(3)

    const delivered = (await eventsFor(hook.id)).filter((e) => e.status === "delivered")
    expect(delivered).toHaveLength(3)
  })

  test("an event not yet due is left alone", async () => {
    const hook = await createWebhook({ userId, url, events: ["quota.exceeded"] })
    await emit({ userId, type: "quota.exceeded", data: {} })
    await db().execute(
      from(webhookEvents)
        .where((q) => q("webhook_id").equals(hook.id))
        .update({ next_attempt_at: new Date(Date.now() + 60_000) }),
    )

    await drainWebhooks(50)
    const [event] = await eventsFor(hook.id)
    expect(event!.status).toBe("pending")
    expect(event!.attempts).toBe(0)
  })
})
