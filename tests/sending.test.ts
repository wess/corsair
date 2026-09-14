import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { createAddress, inboxOf } from "../src/addresses/index.ts"
import { createApiKey, deleteApiKey, resolveApiKey } from "../src/apikeys/index.ts"
import { hashToken } from "../src/auth/index.ts"
import { db } from "../src/db/index.ts"
import { generateKeyPair } from "../src/dkim/index.ts"
import { createWebhook } from "../src/events/index.ts"
import { withIdempotency } from "../src/idempotency/index.ts"
import { inlineBody } from "../src/outbound/index.ts"
import { type Delivery, type Domain, users } from "../src/schema/index.ts"
import {
  afterFailed,
  applyReport,
  bounceTarget,
  cancelEmail,
  createEmail,
  findEmail,
  listEmails,
  prepareSend,
  rescheduleEmail,
  type Sender,
  type SendInput,
} from "../src/sending/index.ts"
import { handleMessage, validateRecipient } from "../src/smtp/inbound/index.ts"
import { drain } from "../src/smtp/queue/index.ts"
import type { Envelope } from "../src/smtp/session/index.ts"
import { messagesIn } from "../src/store/index.ts"
import { isSuppressed, suppress } from "../src/suppressions/index.ts"

/**
 * The sending API against a real database: who may send as what, what leaves,
 * and what comes back.
 *
 * The negative cases carry the weight. A send accepted from a domain the account
 * does not own is an open relay with a JSON front end; a report accepted about
 * an address the email never went to is a way to silence anyone on the account.
 *
 * Needs `bun run db:up && bun run migrate`. Runs with the console transport, so
 * nothing leaves the machine.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `send-${suffix}.invalid`
const pendingZone = `pending-${suffix}.invalid`
const foreignZone = `foreign-${suffix}.invalid`

const created: string[] = []
let userId = ""
let strangerId = ""
let domain: Domain
let sender: Sender

const makeUser = async (label: string): Promise<string> => {
  const id = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Sending', $2) RETURNING id`,
    values: [`${label}-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id
  created.push(id)
  return id
}

const makeDomain = async (owner: string, name: string, status = "active"): Promise<Domain> =>
  (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=send', $3) RETURNING *`,
    values: [owner, name, status],
  }))!

const asUser = (id: string): Sender => ({
  userId: id,
  keyId: null,
  permission: "full_access",
  domainId: null,
})

const send = (input: Partial<SendInput>, as: Sender = sender) =>
  prepareSend(
    {
      from: `Acme <hello@${zone}>`,
      to: "someone@far.invalid",
      subject: "Hello",
      text: "Hello.",
      ...input,
    },
    as,
  )

const rowsFor = (emailId: string): Promise<Delivery[]> =>
  db().all<Delivery>({
    text: "SELECT * FROM deliveries WHERE email_id = $1 ORDER BY rcpt_to",
    values: [emailId],
  })

const lastEvent = async (id: string): Promise<string> => (await findEmail(userId, id)).last_event

const drainAll = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) {
    const result = await drain(50)
    if (!result.attempted) return
  }
}

const envelopeFor = (rcpt: string): Envelope => ({
  helo: "far.invalid",
  mailFrom: "",
  hasSender: true,
  rcptTo: [rcpt],
  size: null,
  smtputf8: false,
})

const dsnFor = (emailId: string, recipient: string, status: string) =>
  [
    "From: Mail Delivery System <MAILER-DAEMON@far.invalid>",
    `To: <bounces+${emailId}@${zone}>`,
    "Subject: Undelivered Mail Returned to Sender",
    "MIME-Version: 1.0",
    'Content-Type: multipart/report; report-type=delivery-status; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain",
    "",
    "It did not arrive.",
    "",
    "--b1",
    "Content-Type: message/delivery-status",
    "",
    "Reporting-MTA: dns; far.invalid",
    "",
    `Final-Recipient: rfc822; ${recipient}`,
    "Action: failed",
    `Status: ${status}`,
    `Diagnostic-Code: smtp; 550 ${status} rejected`,
    "",
    "--b1--",
    "",
  ].join("\r\n")

beforeAll(async () => {
  userId = await makeUser("owner")
  strangerId = await makeUser("stranger")

  // Most of this file sends more than a trial plan's twenty a day.
  await db().execute({
    text: `INSERT INTO subscriptions (user_id, plan_id, status, current_period_end)
           SELECT $1, id, 'active', now() + interval '1 year'
             FROM plans ORDER BY daily_out DESC LIMIT 1`,
    values: [userId],
  })

  domain = await makeDomain(userId, zone)
  await makeDomain(userId, pendingZone, "pending")
  await makeDomain(strangerId, foreignZone)

  const pair = generateKeyPair()
  await db().execute({
    text: `INSERT INTO dkim_keys (domain_id, selector, cname_target, private_key, public_key, active)
           VALUES ($1, 'corsair-1', $2, $3, $4, true)`,
    values: [domain.id, `dkim-1.${zone}`, pair.privateKey, pair.publicKey],
  })

  sender = asUser(userId)
})

afterAll(async () => {
  for (const id of created) {
    await db().execute({
      text: "DELETE FROM deliveries WHERE email_id IN (SELECT id FROM emails WHERE user_id = $1)",
      values: [id],
    })
    await db().execute({ text: "DELETE FROM mail_log WHERE user_id = $1", values: [id] })
    await db().execute(
      from(users)
        .where((q) => q("id").equals(id))
        .del(),
    )
  }
})

describe("who may send", () => {
  test("a verified domain on the account", async () => {
    const prepared = await send({})
    expect(prepared.domain.id).toBe(domain.id)
    expect(prepared.recipients).toEqual(["someone@far.invalid"])
  })

  test("another account's domain is refused exactly like an unverified one", async () => {
    const foreign = await send({ from: `x@${foreignZone}` }).catch((e) => e)
    const pending = await send({ from: `x@${pendingZone}` }).catch((e) => e)
    expect(foreign).toMatchObject({ status: 403, code: "validation_error" })
    expect(pending).toMatchObject({ status: 403, code: "validation_error" })
    // Which domains other accounts host here is not something a refusal leaks.
    expect(foreign.message.replace(foreignZone, "")).toBe(pending.message.replace(pendingZone, ""))
  })

  test("a domain nobody hosts is refused", async () => {
    await expect(send({ from: "x@nowhere.invalid" })).rejects.toMatchObject({ status: 403 })
  })

  test("a key restricted to one domain cannot send from another", async () => {
    const second = await makeDomain(userId, `second-${suffix}.invalid`)
    const scoped = { ...sender, permission: "sending_access" as const, domainId: domain.id }
    await expect(send({ from: `x@${second.name}` }, scoped)).rejects.toMatchObject({
      status: 403,
      code: "validation_error",
    })
    expect((await send({}, scoped)).domain.id).toBe(domain.id)
  })
})

describe("what a send must contain", () => {
  const refused: [string, Partial<SendInput>, number, string][] = [
    ["no from", { from: "" }, 422, "missing_required_field"],
    ["a malformed from", { from: "not an address" }, 422, "invalid_from_address"],
    ["two senders", { from: `a@${zone}, b@${zone}` }, 422, "invalid_from_address"],
    ["no recipient", { to: [] }, 422, "missing_required_field"],
    ["a malformed recipient", { to: ["nope"] }, 400, "invalid_parameter"],
    ["no subject", { subject: undefined }, 422, "missing_required_field"],
    ["no body", { text: null, html: null }, 422, "missing_required_field"],
    [
      "more than fifty recipients",
      { to: Array.from({ length: 51 }, (_, i) => `r${i}@far.invalid`) },
      400,
      "invalid_parameter",
    ],
    [
      "a header this server writes",
      { headers: { Bcc: "x@far.invalid" } },
      400,
      "invalid_parameter",
    ],
    ["a header name with a colon", { headers: { "X-A:B": "v" } }, 400, "invalid_parameter"],
    ["a tag with a space", { tags: [{ name: "bad tag", value: "x" }] }, 400, "invalid_parameter"],
    [
      "an attachment fetched by path",
      { attachments: [{ filename: "a.pdf", path: "http://169.254.169.254/latest/meta-data" }] },
      422,
      "invalid_attachment",
    ],
    [
      "an executable",
      { attachments: [{ filename: "setup.exe", content: "AAAA" }] },
      422,
      "invalid_attachment",
    ],
    [
      "content that is not base64",
      { attachments: [{ filename: "a.txt", content: "not base64!" }] },
      422,
      "invalid_attachment",
    ],
    ["a template", { template: { id: "welcome" } }, 400, "invalid_parameter"],
    ["a schedule too far ahead", { scheduled_at: "in 60 days" }, 400, "invalid_parameter"],
    ["a schedule that is not a date", { scheduled_at: "soonish" }, 400, "invalid_parameter"],
  ]

  for (const [label, input, status, code] of refused) {
    test(`refuses ${label}`, async () => {
      await expect(send(input)).rejects.toMatchObject({ status, code })
    })
  }
})

describe("the message that leaves", () => {
  test("is signed, carries reply-to, and never shows bcc", async () => {
    const prepared = await send({
      to: ["Pat <pat@far.invalid>"],
      cc: "cc@far.invalid",
      bcc: ["hidden@far.invalid"],
      reply_to: "support@far.invalid",
      html: "<p>Hi</p>",
      text: "Hi",
      headers: { "X-Entity-Ref-ID": "123" },
    })
    expect(prepared.signed).toBe(true)
    expect(prepared.raw).toStartWith("DKIM-Signature:")
    expect(prepared.raw).toContain("Reply-To: support@far.invalid")
    expect(prepared.raw).toContain("X-Entity-Ref-ID: 123")
    expect(prepared.raw).not.toContain("hidden@far.invalid")
    expect([...prepared.recipients].sort()).toEqual([
      "cc@far.invalid",
      "hidden@far.invalid",
      "pat@far.invalid",
    ])
  })

  test("a custom header value cannot start a header of its own", async () => {
    const prepared = await send({ headers: { "X-Note": "a\r\nBcc: evil@far.invalid" } })
    expect(prepared.raw).not.toContain("\r\nBcc:")
  })

  test("an attachment with a content id goes inline", async () => {
    const prepared = await send({
      html: '<img src="cid:logo">',
      attachments: [
        {
          filename: "logo.png",
          content: Buffer.from("png").toString("base64"),
          content_id: "logo",
        },
        { filename: "terms.txt", content: [104, 105] },
      ],
    })
    expect(prepared.raw).toContain("Content-ID: <logo>")
    expect(prepared.raw).toContain('Content-Disposition: inline; filename="logo.png"')
    expect(prepared.raw).toContain('Content-Disposition: attachment; filename="terms.txt"')
  })
})

describe("queueing", () => {
  test("one row per recipient, each on the email's bounce address", async () => {
    const email = await createEmail(
      await send({ to: ["a@far.invalid", "A@far.invalid", "b@far.invalid"] }),
      sender,
    )
    expect(email.last_event).toBe("sent")

    const rows = await rowsFor(email.id)
    expect(rows.map((r) => r.rcpt_to)).toEqual(["a@far.invalid", "b@far.invalid"])
    for (const row of rows) expect(row.mail_from).toBe(`bounces+${email.id}@${zone}`)
    expect(inlineBody(rows[0]!.storage_key!)).toContain("DKIM-Signature:")
  })

  test("a send counts toward the daily limit", async () => {
    const trial = await db().one<{ daily_out: number }>({
      text: "SELECT daily_out FROM plans WHERE is_trial ORDER BY position LIMIT 1",
      values: [],
    })
    // An unseeded database has no plans and runs unmetered; nothing to hold.
    if (!trial?.daily_out) return

    const trialId = await makeUser("trial")
    const trialZone = `trial-${suffix}.invalid`
    await makeDomain(trialId, trialZone)
    for (let i = 0; i < trial.daily_out; i++) {
      await db().execute({
        text: "INSERT INTO mail_log (user_id, direction, status) VALUES ($1, 'outbound', 'accepted')",
        values: [trialId],
      })
    }

    const as = asUser(trialId)
    const prepared = await send({ from: `x@${trialZone}` }, as)
    await expect(createEmail(prepared, as)).rejects.toMatchObject({
      status: 429,
      code: "daily_quota_exceeded",
    })
  })
})

describe("delivery", () => {
  test("a delivered send reports email.* and nothing from the message.* family", async () => {
    const hook = await createWebhook({ userId, url: "https://example.com/hook", events: ["*"] })
    const email = await createEmail(await send({ to: "delivered@far.invalid" }), sender)
    await drainAll()

    expect(await lastEvent(email.id)).toBe("delivered")
    const types = await db().all<{ type: string }>({
      text: `SELECT type FROM webhook_events
              WHERE webhook_id = $1 AND payload->'data'->>'email_id' = $2 ORDER BY created_at`,
      values: [hook.id, email.id],
    })
    expect(types.map((t) => t.type)).toEqual(["email.sent", "email.delivered"])

    const legacy = await db().all({
      text: "SELECT id FROM webhook_events WHERE webhook_id = $1 AND type LIKE 'message.%'",
      values: [hook.id],
    })
    expect(legacy).toHaveLength(0)
  })

  test("a suppressed recipient is settled without an attempt", async () => {
    await suppress({ userId, address: "Blocked@far.invalid", reason: "manual" })
    const email = await createEmail(await send({ to: "blocked@far.invalid" }), sender)
    await drainAll()

    const [row] = await rowsFor(email.id)
    expect(row!.status).toBe("suppressed")
    expect(row!.sent_at).toBeNull()
    expect(await lastEvent(email.id)).toBe("suppressed")
  })

  test("a permanent failure for an address that is gone suppresses it", async () => {
    const email = await createEmail(await send({ to: "gone@far.invalid" }), sender)
    const [row] = await rowsFor(email.id)
    await afterFailed(row!, 550, "5.1.1 <gone@far.invalid>: Recipient address rejected")

    expect(await isSuppressed(userId, "gone@far.invalid")).toBe(true)
    expect(await lastEvent(email.id)).toBe("bounced")
  })

  test("a permanent refusal of the content does not", async () => {
    const email = await createEmail(await send({ to: "picky@far.invalid" }), sender)
    const [row] = await rowsFor(email.id)
    await afterFailed(row!, 550, "5.7.1 Message rejected due to content restrictions")

    expect(await isSuppressed(userId, "picky@far.invalid")).toBe(false)
    expect(await lastEvent(email.id)).toBe("bounced")
  })

  test("suppression is per account", async () => {
    await suppress({ userId, address: "shared@far.invalid", reason: "bounce" })
    expect(await isSuppressed(strangerId, "shared@far.invalid")).toBe(false)
  })
})

describe("scheduling", () => {
  test("a scheduled send waits, and can be moved", async () => {
    const email = await createEmail(await send({ scheduled_at: "in 2 hours" }), sender)
    expect(email.last_event).toBe("scheduled")
    const [row] = await rowsFor(email.id)
    expect(row!.run_at.getTime()).toBeGreaterThan(Date.now() + 90 * 60_000)

    const later = new Date(Date.now() + 5 * 3_600_000)
    await rescheduleEmail(email, later.toISOString())
    const [moved] = await rowsFor(email.id)
    expect(Math.abs(moved!.run_at.getTime() - later.getTime())).toBeLessThan(1000)
  })

  test("canceling settles its rows, and only a scheduled send can be canceled", async () => {
    const email = await createEmail(
      await send({ to: ["one@far.invalid", "two@far.invalid"], scheduled_at: "in 1 hour" }),
      sender,
    )
    await cancelEmail(email)

    const rows = await rowsFor(email.id)
    expect(rows.map((r) => r.status)).toEqual(["cancelled", "cancelled"])
    expect(await lastEvent(email.id)).toBe("canceled")
    await expect(cancelEmail(email)).rejects.toMatchObject({ status: 400 })

    const immediate = await createEmail(await send({}), sender)
    await expect(cancelEmail(immediate)).rejects.toMatchObject({ status: 400 })
  })

  test("a scheduled send is sent, then delivered, when its time comes", async () => {
    const email = await createEmail(await send({ scheduled_at: "in 1 hour" }), sender)
    await db().execute({
      text: "UPDATE deliveries SET run_at = now() - interval '1 second' WHERE email_id = $1",
      values: [email.id],
    })
    await drainAll()
    expect(await lastEvent(email.id)).toBe("delivered")
  })
})

describe("reports at the bounce address", () => {
  test("resolve only on the email's own domain", async () => {
    const email = await createEmail(await send({}), sender)
    expect((await bounceTarget(`bounces+${email.id}@${zone}`))?.id).toBe(email.id)
    expect(await bounceTarget(`bounces+${email.id}@${foreignZone}`)).toBeNull()
    expect(await bounceTarget(`bounces+00000000-0000-0000-0000-000000000000@${zone}`)).toBeNull()
  })

  test("are accepted and applied ahead of the domain's catch-all", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "everything",
      type: "catchall",
      password: "hunter2hunter2",
    })
    const email = await createEmail(await send({ to: "bounced@far.invalid" }), sender)
    const rcpt = `bounces+${email.id}@${zone}`

    expect(await validateRecipient(rcpt, null, envelopeFor(rcpt))).toBeNull()
    const reply = await handleMessage(
      envelopeFor(rcpt),
      dsnFor(email.id, "bounced@far.invalid", "5.1.1"),
      { remoteIp: "203.0.113.9", helo: "far.invalid" },
    )
    expect(reply.code).toBe(250)
    expect(await isSuppressed(userId, "bounced@far.invalid")).toBe(true)
    expect(await lastEvent(email.id)).toBe("bounced")

    // The report was processed, not filed as mail.
    expect(await messagesIn((await inboxOf(address.id)).id)).toHaveLength(0)
  })

  test("a report about somebody the email never went to changes nothing", async () => {
    const email = await createEmail(await send({ to: "real@far.invalid" }), sender)
    const result = await applyReport(email, dsnFor(email.id, "victim@far.invalid", "5.1.1"))
    expect(result.applied).toBe(0)
    expect(await isSuppressed(userId, "victim@far.invalid")).toBe(false)
  })

  test("a complaint suppresses the address that complained", async () => {
    const email = await createEmail(await send({ to: "annoyed@far.invalid" }), sender)
    const complaint = [
      "From: <fbl@far.invalid>",
      "MIME-Version: 1.0",
      'Content-Type: multipart/report; report-type=feedback-report; boundary="b2"',
      "",
      "--b2",
      "Content-Type: message/feedback-report",
      "",
      "Feedback-Type: abuse",
      "Version: 1",
      "Original-Rcpt-To: <annoyed@far.invalid>",
      "",
      "--b2--",
      "",
    ].join("\r\n")

    expect((await applyReport(email, complaint)).applied).toBe(1)
    expect(await isSuppressed(userId, "annoyed@far.invalid")).toBe(true)
    expect(await lastEvent(email.id)).toBe("complained")
  })

  test("an auto-reply is not a report", async () => {
    const email = await createEmail(await send({ to: "away@far.invalid" }), sender)
    const reply = "From: away@far.invalid\r\nSubject: Out of office\r\n\r\nBack Monday.\r\n"
    expect((await applyReport(email, reply)).applied).toBe(0)
    expect(await isSuppressed(userId, "away@far.invalid")).toBe(false)
    expect(await lastEvent(email.id)).toBe("sent")
  })
})

describe("keys", () => {
  test("resolve by token, store only a hash, and stop at revocation", async () => {
    const { key, token } = await createApiKey({
      userId,
      name: "site",
      permission: "sending_access",
    })
    expect(token).toStartWith("cs_")
    expect(key.token_hash).toBe(hashToken(token))
    expect(JSON.stringify(key)).not.toContain(token)

    expect((await resolveApiKey(token))?.id).toBe(key.id)
    expect(await resolveApiKey(`${token}x`)).toBeNull()
    expect(await resolveApiKey("re_not_one_of_ours")).toBeNull()

    expect(await deleteApiKey(strangerId, key.id)).toBe(false)
    expect(await deleteApiKey(userId, key.id)).toBe(true)
    expect(await resolveApiKey(token)).toBeNull()
  })

  test("stop working with their account", async () => {
    const { token } = await createApiKey({
      userId: strangerId,
      name: "x",
      permission: "full_access",
    })
    await db().execute({
      text: "UPDATE users SET status = 'terminated' WHERE id = $1",
      values: [strangerId],
    })
    expect(await resolveApiKey(token)).toBeNull()
    await db().execute({
      text: "UPDATE users SET status = 'active' WHERE id = $1",
      values: [strangerId],
    })
  })

  test("a key scoped to a domain can only send", async () => {
    await expect(
      db().execute({
        text: `INSERT INTO api_keys (user_id, domain_id, name, permission, token_hash, token_prefix)
               VALUES ($1, $2, 'bad', 'full_access', $3, 'cs_bad')`,
        values: [userId, domain.id, `hash-${suffix}`],
      }),
    ).rejects.toThrow()
  })
})

describe("idempotency", () => {
  test("a repeat replays the first answer without running again", async () => {
    let runs = 0
    const work = async () => ({ id: `run-${++runs}` })
    const first = await withIdempotency(userId, `key-${suffix}`, { a: 1 }, work)
    const second = await withIdempotency(userId, `key-${suffix}`, { a: 1 }, work)
    expect(runs).toBe(1)
    expect(second).toEqual(first)
  })

  test("the same key with a different body is refused", async () => {
    await expect(
      withIdempotency(userId, `key-${suffix}`, { a: 2 }, async () => ({})),
    ).rejects.toMatchObject({ status: 409, code: "invalid_idempotent_request" })
  })

  test("a failed request releases its key", async () => {
    const key = `fail-${suffix}`
    await expect(
      withIdempotency(userId, key, {}, async () => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")
    expect((await withIdempotency(userId, key, {}, async () => ({ ok: true }))).body).toEqual({
      ok: true,
    })
  })

  test("keys belong to one account", async () => {
    const other = await withIdempotency(strangerId, `key-${suffix}`, { a: 2 }, async () => ({
      mine: true,
    }))
    expect(other.body).toEqual({ mine: true })
  })
})

describe("listing", () => {
  test("pages newest first with Resend's cursors, and only the account's own", async () => {
    const lister = await makeUser("lister")
    const listZone = `list-${suffix}.invalid`
    await makeDomain(lister, listZone)
    const as = asUser(lister)

    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      const prepared = await send({ from: `x@${listZone}`, subject: `n${i}` }, as)
      ids.push((await createEmail(prepared, as)).id)
    }

    const first = await listEmails(lister, { limit: "2" })
    expect(first.data.map((e) => e.id)).toEqual([ids[2]!, ids[1]!])
    expect(first.hasMore).toBe(true)

    const older = await listEmails(lister, { limit: "2", after: ids[1] })
    expect(older.data.map((e) => e.id)).toEqual([ids[0]!])
    expect(older.hasMore).toBe(false)

    const newer = await listEmails(lister, { limit: "1", before: ids[0] })
    expect(newer.data.map((e) => e.id)).toEqual([ids[1]!])
    expect(newer.hasMore).toBe(true)

    await expect(listEmails(lister, { limit: "0" })).rejects.toMatchObject({ status: 400 })
    const mine = await listEmails(userId, { limit: "100" })
    expect(mine.data.some((e) => ids.includes(e.id))).toBe(false)
  })
})
