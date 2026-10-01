import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createAddress } from "../src/addresses/index.ts"
import { db } from "../src/db/index.ts"
import { enqueue } from "../src/outbound/index.ts"
import type { Domain } from "../src/schema/index.ts"
import type { Envelope } from "../src/smtp/session/index.ts"
import { authenticate, handleMessage, validateSender } from "../src/smtp/submission/index.ts"

/**
 * What an authenticated submitter may put in the sender fields, against a real
 * database. Two customers share this server; neither may send as the other, in
 * the envelope or in the From header the recipient actually sees.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const mineZone = `mine-${suffix}.invalid`
const theirsZone = `theirs-${suffix}.invalid`
const password = "correct horse battery staple"

let me = ""
let them = ""
let mine: Domain
let theirs: Domain

const makeUser = async (label: string): Promise<string> =>
  (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Forgery', $2) RETURNING id`,
    values: [`${label}-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id

const makeDomain = async (owner: string, name: string): Promise<Domain> =>
  (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=forgery', 'active') RETURNING *`,
    values: [owner, name],
  }))!

const envelope = (from: string, to: string): Envelope => ({
  helo: "client.invalid",
  mailFrom: from,
  hasSender: true,
  rcptTo: [to],
  size: null,
  smtputf8: false,
})

const message = (from: string, to: string) =>
  [
    `From: ${from}`,
    `To: ${to}`,
    "Subject: hi",
    "Date: Mon, 1 Jan 2026 00:00:00 +0000",
    "",
    "hello",
    "",
  ].join("\r\n")

beforeAll(async () => {
  me = await makeUser("me")
  them = await makeUser("them")
  mine = await makeDomain(me, mineZone)
  theirs = await makeDomain(them, theirsZone)
  await createAddress({ domainId: mine.id, localPart: "alice", type: "standard", password })
  await createAddress({ domainId: mine.id, localPart: "billing", type: "standard", password })
  await createAddress({ domainId: theirs.id, localPart: "ceo", type: "standard", password })
})

afterAll(async () => {
  for (const id of [me, them]) {
    await db().execute({
      text: "DELETE FROM deliveries WHERE domain_id IN (SELECT id FROM domains WHERE user_id = $1)",
      values: [id],
    })
    await db().execute({ text: "DELETE FROM mail_log WHERE user_id = $1", values: [id] })
    await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [id] })
  }
})

describe("the envelope sender", () => {
  test("may be the caller's own address, or another address on a domain the account owns", async () => {
    const session = await authenticate(`alice@${mineZone}`, password)
    expect(session).not.toBeNull()
    expect(await validateSender(`alice@${mineZone}`, session)).toBeNull()
    expect(await validateSender(`billing@${mineZone}`, session)).toBeNull()
  })

  test("may not be another customer's", async () => {
    const session = await authenticate(`alice@${mineZone}`, password)
    expect((await validateSender(`ceo@${theirsZone}`, session))?.code).toBe(550)
  })
})

describe("the From header", () => {
  test("is refused when it names another customer, even with an honest envelope", async () => {
    const session = await authenticate(`alice@${mineZone}`, password)
    const reply = await handleMessage(
      envelope(`alice@${mineZone}`, "victim@far.invalid"),
      message(`"The CEO" <ceo@${theirsZone}>`, "victim@far.invalid"),
      session,
    )
    expect(reply.code).toBe(550)
  })

  test("is refused when any one of several From addresses is not the caller's", async () => {
    const session = await authenticate(`alice@${mineZone}`, password)
    const reply = await handleMessage(
      envelope(`alice@${mineZone}`, "victim@far.invalid"),
      message(`alice@${mineZone}, ceo@${theirsZone}`, "victim@far.invalid"),
      session,
    )
    expect(reply.code).toBe(550)
  })

  test("is accepted when it is the caller's own, or another of the account's", async () => {
    const session = await authenticate(`alice@${mineZone}`, password)
    for (const from of [`alice@${mineZone}`, `Billing <billing@${mineZone}>`]) {
      const reply = await handleMessage(
        envelope(`alice@${mineZone}`, "someone@far.invalid"),
        message(from, "someone@far.invalid"),
        session,
      )
      expect(reply.code).toBe(250)
    }
  })
})

describe("the queue", () => {
  test("refuses an address that would end the SMTP command and start another", async () => {
    const raw = "From: a@b.invalid\r\n\r\nx\r\n"
    await expect(
      enqueue({ raw, mailFrom: "a@b.invalid", recipients: ["x@far.invalid>\r\nRSET"] }),
    ).rejects.toThrow(/unsafe recipient/)
    await expect(
      enqueue({
        raw,
        mailFrom: "a@b.invalid>\r\nMAIL FROM:<x@y.invalid",
        recipients: ["x@far.invalid"],
      }),
    ).rejects.toThrow(/unsafe envelope sender/)
  })

  test("still accepts the null reverse path, which every bounce uses", async () => {
    const rows = await enqueue({
      raw: "From: mailer-daemon@mine.invalid\r\n\r\nx\r\n",
      mailFrom: "",
      recipients: ["x@far.invalid"],
      domainId: mine.id,
    })
    expect(rows).toHaveLength(1)
  })
})
