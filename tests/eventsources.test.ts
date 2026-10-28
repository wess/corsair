import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@wess/atlas/db/query"
import { Glob } from "bun"
import { createAddress } from "../src/addresses/index.ts"
import { db } from "../src/db/index.ts"
import { createWebhook, EVENT_TYPES } from "../src/events/index.ts"
import { recordSent } from "../src/mailsend/index.ts"
import { withinDailyLimit } from "../src/plans/index.ts"
import {
  type Address,
  type Domain,
  users,
  type WebhookEvent,
  webhookEvents,
} from "../src/schema/index.ts"
import { stateFor, updateStorageState } from "../src/storagestate/index.ts"
import { runTransferJob } from "../src/worker/index.ts"

/**
 * Every event the catalogue advertises is one something actually emits.
 *
 * `message.sent`, `transfer.completed` and `transfer.failed` were listed, shown
 * in the panel's picker and documented for months with no emit site at all: a
 * customer could subscribe and would never hear a thing. Nothing failed, because
 * an event nobody emits looks exactly like a quiet day.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
let userId = ""
let domain: Domain
let address: Address

const eventsFor = (hookId: string) =>
  db().all<WebhookEvent>(
    from(webhookEvents)
      .where((q) => q("webhook_id").equals(hookId))
      .orderBy("created_at", "ASC"),
  )

beforeAll(async () => {
  userId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Sources', $2) RETURNING id`,
    values: [`sources-${suffix}@corsair.test`, `s${suffix}`],
  }))!.id
  domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=sources', 'active') RETURNING *`,
    values: [userId, `sources-${suffix}.invalid`],
  }))!
  address = (
    await createAddress({
      domainId: domain.id,
      localPart: "me",
      type: "standard",
      password: "correct horse battery",
    })
  ).address
})

afterAll(async () => {
  await db().execute({ text: "DELETE FROM subscriptions WHERE user_id = $1", values: [userId] })
  await db().execute({ text: "DELETE FROM plans WHERE key = $1", values: [`tiny-${suffix}`] })
  await db().execute({ text: "DELETE FROM mail_log WHERE user_id = $1", values: [userId] })
  await db().execute({ text: "DELETE FROM transfers WHERE user_id = $1", values: [userId] })
  await db().execute(
    from(users)
      .where((q) => q("id").equals(userId))
      .del(),
  )
})

describe("the catalogue", () => {
  test("every advertised event type has an emit site", async () => {
    let source = ""
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      if (file === "src/events/index.ts") continue
      source += await Bun.file(file).text()
    }
    const silent = EVENT_TYPES.filter((type) => !source.includes(`"${type}"`))
    expect(silent).toEqual([])
  })
})

describe("message.sent", () => {
  test("is emitted per recipient, and the send counts against the daily limit", async () => {
    const hook = await createWebhook({
      userId,
      url: "https://hooks.invalid/x",
      events: ["message.sent"],
    })
    const before = (await withinDailyLimit(userId, "outbound", 1000)).used

    await recordSent({
      owner: userId,
      domainId: domain.id,
      addressId: address.id,
      mailFrom: `me@${domain.name}`,
      recipients: ["a@elsewhere.test", "b@elsewhere.test"],
      subject: "Hello",
      messageId: "<one@sources.test>",
      size: 120,
      signed: true,
    })

    // A send path that skipped the journal sent mail nothing counted. JMAP did.
    expect((await withinDailyLimit(userId, "outbound", 1000)).used).toBe(before + 2)

    // emit() is fire-and-forget from recordSent.
    await Bun.sleep(50)
    const events = await eventsFor(hook.id)
    expect(
      events.map((e) => (e.payload as { data: { recipient: string } }).data.recipient),
    ).toEqual(["a@elsewhere.test", "b@elsewhere.test"])
    expect(events.every((e) => e.type === "message.sent")).toBe(true)
  })
})

describe("transfer.failed", () => {
  test("is emitted once, however many times the job runs", async () => {
    const hook = await createWebhook({
      userId,
      url: "https://hooks.invalid/t",
      events: ["transfer.*"],
    })
    // No stored password: runTransfer throws before touching the network.
    const transfer = (await db().one<{ id: string }>({
      text: `INSERT INTO transfers (user_id, address_id, server, username, password_enc)
             VALUES ($1, $2, 'imap.elsewhere.test', 'someone', NULL) RETURNING id`,
      values: [userId, address.id],
    }))!

    await expect(runTransferJob(transfer.id)).rejects.toThrow()
    await runTransferJob(transfer.id)
    await Bun.sleep(50)

    const events = await eventsFor(hook.id)
    expect(events.map((e) => e.type)).toEqual(["transfer.failed"])
    const data = (events[0]!.payload as { data: Record<string, unknown> }).data
    expect(data.transfer_id).toBe(transfer.id)
    expect(data.address).toBe(`me@${domain.name}`)
    expect(data).not.toHaveProperty("password_enc")

    const row = await db().one<{ status: string; password_enc: string | null }>({
      text: "SELECT status, password_enc FROM transfers WHERE id = $1",
      values: [transfer.id],
    })
    expect(row).toEqual({ status: "failed", password_enc: null })
  })

  test("a cancelled transfer announces nothing", async () => {
    const hook = await createWebhook({
      userId,
      url: "https://hooks.invalid/c",
      events: ["transfer.*"],
    })
    const transfer = (await db().one<{ id: string }>({
      text: `INSERT INTO transfers (user_id, address_id, server, username, status)
             VALUES ($1, $2, 'imap.elsewhere.test', 'someone', 'cancelled') RETURNING id`,
      values: [userId, address.id],
    }))!
    await runTransferJob(transfer.id)
    await Bun.sleep(50)
    expect(await eventsFor(hook.id)).toHaveLength(0)
  })
})

describe("quota.warning and quota.exceeded", () => {
  test("the thresholds", () => {
    expect(stateFor(0, 1000)).toBe("ok")
    expect(stateFor(899, 1000)).toBe("ok")
    expect(stateFor(900, 1000)).toBe("warning")
    expect(stateFor(1000, 1000)).toBe("exceeded")
    // An unmetered account is never warned.
    expect(stateFor(10 ** 15, Number.MAX_SAFE_INTEGER)).toBe("ok")
  })

  test("are announced once per crossing, on the way up only", async () => {
    const plan = (await db().one<{ id: string }>({
      text: `INSERT INTO plans (key, name, storage_bytes, daily_in, daily_out)
             VALUES ($1, 'Tiny', 1000, 0, 0) RETURNING id`,
      values: [`tiny-${suffix}`],
    }))!
    await db().execute({
      text: `INSERT INTO subscriptions (user_id, plan_id, status, current_period_end)
             VALUES ($1, $2, 'active', now() + interval '1 year')`,
      values: [userId, plan.id],
    })
    const hook = await createWebhook({
      userId,
      url: "https://hooks.invalid/q",
      events: ["quota.*"],
    })
    const fill = (bytes: number) =>
      db().execute({
        text: "UPDATE addresses SET bytes_used = $2 WHERE id = $1",
        values: [address.id, bytes],
      })
    const types = async () => {
      await Bun.sleep(50)
      return (await eventsFor(hook.id)).map((e) => e.type)
    }

    await fill(500)
    expect(await updateStorageState(userId)).toBe("ok")
    expect(await types()).toEqual([])

    await fill(950)
    expect(await updateStorageState(userId)).toBe("warning")
    expect(await updateStorageState(userId)).toBe("warning")
    expect(await types()).toEqual(["quota.warning"])

    // A refused delivery counts the message that did not fit.
    expect(await updateStorageState(userId, 100)).toBe("exceeded")
    expect(await types()).toEqual(["quota.warning", "quota.exceeded"])

    // Freeing space is silent, and the next climb is announced again.
    await fill(100)
    expect(await updateStorageState(userId)).toBe("ok")
    await fill(920)
    await updateStorageState(userId)
    expect(await types()).toEqual(["quota.warning", "quota.exceeded", "quota.warning"])

    await fill(0)
  })
})
