import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createAddress } from "../src/addresses/index.ts"
import { createAgent, resolveAgent, rotateAgentToken } from "../src/agents/index.ts"
import { buildFetch } from "../src/api/index.ts"
import { createApiKey } from "../src/apikeys/index.ts"
import { authenticateAddress, hashToken } from "../src/auth/index.ts"
import { db } from "../src/db/index.ts"
import type { Agent, Domain } from "../src/schema/index.ts"
import { handleMessage } from "../src/smtp/inbound/index.ts"
import type { Envelope } from "../src/smtp/session/index.ts"

/**
 * Agent email against a real database.
 *
 * What matters here is the boundary: an agent token reads one mailbox and
 * nothing else, a sending key is not an agent token, an agent token is not a
 * sending key, and the mailbox is not a login for any mail protocol.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `agents-${suffix}.invalid`
const app = buildFetch(null)

let userId = ""
let domain: Domain
let one: { agent: Agent; token: string; email: string; id: string }
let two: { agent: Agent; token: string; email: string; id: string }

const make = async (name: string) => {
  const made = await createAgent({ userId, domain, name })
  return {
    agent: made.agent,
    token: made.token,
    email: `${made.address.local_part}@${zone}`,
    id: made.address.id,
  }
}

const mail = (to: string, subject: string, body: string, from = "noreply@shop.invalid") =>
  handleMessage(
    {
      helo: "shop.invalid",
      mailFrom: from,
      hasSender: true,
      rcptTo: [to],
      size: null,
      smtputf8: false,
    } satisfies Envelope,
    [
      `From: Shop <${from}>`,
      `To: <${to}>`,
      `Subject: ${subject}`,
      `Message-ID: <${Math.random().toString(36).slice(2)}@shop.invalid>`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      "",
    ].join("\r\n"),
    { remoteIp: "203.0.113.9", helo: "shop.invalid" },
  )

const call = (path: string, token: string | null, init: RequestInit = {}) =>
  app(
    new Request(`http://corsair.test${path}`, {
      ...init,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    }),
  )

beforeAll(async () => {
  userId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Agents', $2) RETURNING id`,
    values: [`agents-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id
  domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=agents', 'active') RETURNING *`,
    values: [userId, zone],
  }))!
  one = await make("first")
  two = await make("second")
})

afterAll(async () => {
  await db().execute({
    text: "DELETE FROM deliveries WHERE domain_id = $1",
    values: [domain.id],
  })
  await db().execute({ text: "DELETE FROM mail_log WHERE user_id = $1", values: [userId] })
  await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [userId] })
})

describe("the mailbox", () => {
  test("is an agent address with no password", async () => {
    const row = await db().one<{
      type: string
      password_hash: string | null
      user_id: string | null
    }>({
      text: "SELECT type, password_hash, user_id FROM addresses WHERE id = $1",
      values: [one.id],
    })
    expect(row?.type).toBe("agent")
    expect(row?.password_hash).toBeNull()
    expect(row?.user_id).toBeNull()
  })

  test("is not a login for IMAP, POP3, SMTP, or the webmail", async () => {
    // Every one of them goes through this. Whatever is tried, it is refused.
    expect(await authenticateAddress(one.email, one.token)).toBeNull()
    expect(await authenticateAddress(one.email, "")).toBeNull()
    expect(await authenticateAddress(one.email, "password")).toBeNull()
  })

  test("cannot be created through the ordinary address route's enum", async () => {
    await expect(
      createAddress({ domainId: domain.id, localPart: `plain-${suffix}`, type: "standard" }),
    ).rejects.toThrow()
  })

  test("stores only a hash of the token", async () => {
    const row = await db().one<{ token_hash: string; token_prefix: string }>({
      text: "SELECT token_hash, token_prefix FROM agents WHERE id = $1",
      values: [one.agent.id],
    })
    expect(row?.token_hash).toBe(hashToken(one.token))
    expect(row?.token_hash).not.toContain(one.token)
    expect(one.token.startsWith(row!.token_prefix)).toBe(true)
  })
})

describe("the token", () => {
  test("resolves to its own mailbox", async () => {
    const resolved = await resolveAgent(one.token)
    expect(resolved?.address.id).toBe(one.id)
    expect(await resolveAgent(`ca_${"x".repeat(43)}`)).toBeNull()
    expect(await resolveAgent("cs_whatever")).toBeNull()
  })

  test("rotating replaces it at once", async () => {
    const third = await make("rotating")
    const before = third.token
    const { token } = await rotateAgentToken(third.agent)
    expect(token).not.toBe(before)
    expect(await resolveAgent(before)).toBeNull()
    expect((await resolveAgent(token))?.address.id).toBe(third.id)
  })

  test("stops working when the mailbox is disabled", async () => {
    const gone = await make("disabled")
    expect(await resolveAgent(gone.token)).not.toBeNull()
    await db().execute({
      text: "UPDATE addresses SET disabled = true WHERE id = $1",
      values: [gone.id],
    })
    expect(await resolveAgent(gone.token)).toBeNull()
  })

  test("is refused by the sending API, and a sending key is refused here", async () => {
    const asAgent = await call("/api/emails", one.token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from: one.email, to: "x@far.invalid", subject: "no", text: "no" }),
    })
    expect(asAgent.status).toBe(403)

    const { token: sendingKey } = await createApiKey({
      userId,
      name: "k",
      permission: "full_access",
    })
    const asKey = await call("/api/agent/messages", sendingKey)
    expect(asKey.status).toBe(403)

    expect((await call("/api/agent/messages", null)).status).toBe(401)
  })
})

describe("reading", () => {
  test("a message sent to the address is in its inbox with the link and the code", async () => {
    const reply = await mail(
      one.email,
      "Confirm your account",
      "Your verification code is 482913.\r\nOr open https://shop.invalid/verify?t=abc.",
    )
    expect(reply.code).toBe(250)

    const list = await (await call("/api/agent/messages?subject=confirm", one.token)).json()
    expect(list.data).toHaveLength(1)

    const message = await (await call(`/api/agent/messages/${list.data[0].id}`, one.token)).json()
    expect(message.codes).toEqual(["482913"])
    expect(message.links).toEqual(["https://shop.invalid/verify?t=abc"])
    expect(message.text).toContain("verification code")
  })

  test("a tagged address lands in the same inbox and keeps its tag", async () => {
    const [local] = one.email.split("@")
    const tagged = `${local}+shop@${zone}`
    expect((await mail(tagged, "Tagged", "hello")).code).toBe(250)

    const list = await (await call("/api/agent/messages?subject=tagged", one.token)).json()
    expect(list.data).toHaveLength(1)
    expect(list.data[0].to.join(",")).toContain("+shop@")
  })

  test("one agent cannot read another's mail", async () => {
    await mail(two.email, "Private to two", "secret 111222")
    const mine = await (await call("/api/agent/messages?subject=private", one.token)).json()
    expect(mine.data).toHaveLength(0)

    const theirs = await (await call("/api/agent/messages?subject=private", two.token)).json()
    expect(theirs.data).toHaveLength(1)

    const stolen = await call(`/api/agent/messages/${theirs.data[0].id}`, one.token)
    expect(stolen.status).toBe(404)
  })

  test("a search term with a wildcard is a character, not a pattern", async () => {
    await mail(one.email, "Fifty percent", "x")
    const hit = await (await call("/api/agent/messages?subject=%25", one.token)).json()
    expect(hit.data).toHaveLength(0)
  })

  test("wait returns mail that arrives while it is waiting, and nothing from before", async () => {
    await mail(one.email, "Old news", "arrived before the call")

    const waiting = call("/api/agent/wait?timeout=10&subject=fresh", one.token)
    await Bun.sleep(1_200)
    await mail(one.email, "Fresh arrival", "Your code is 777888")
    const got = await (await waiting).json()
    expect(got.matched).toBe(true)
    expect(got.subject).toBe("Fresh arrival")
    expect(got.codes).toEqual(["777888"])

    const old = await (await call("/api/agent/wait?timeout=2&subject=old", one.token)).json()
    expect(old.matched).toBe(false)
  })
})

describe("attachments", () => {
  test("an attachment downloads as opaque bytes, from its own mailbox only", async () => {
    const boundary = "b-agent"
    const raw = [
      "From: Shop <noreply@shop.invalid>",
      `To: <${one.email}>`,
      "Subject: Your invoice",
      `Message-ID: <${Math.random().toString(36).slice(2)}@shop.invalid>`,
      "MIME-Version: 1.0",
      `Content-Type: multipart/mixed; boundary="${boundary}"`,
      "",
      `--${boundary}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Invoice attached.",
      `--${boundary}`,
      'Content-Type: text/html; name="inv.html"',
      'Content-Disposition: attachment; filename="inv.html"',
      "Content-Transfer-Encoding: base64",
      "",
      Buffer.from("<script>alert(1)</script>").toString("base64"),
      `--${boundary}--`,
      "",
    ].join("\r\n")
    const envelope: Envelope = {
      helo: "shop.invalid",
      mailFrom: "noreply@shop.invalid",
      hasSender: true,
      rcptTo: [one.email],
      size: null,
      smtputf8: false,
    }
    expect(
      (await handleMessage(envelope, raw, { remoteIp: "203.0.113.9", helo: "shop.invalid" })).code,
    ).toBe(250)

    const list = await (await call("/api/agent/messages?subject=invoice", one.token)).json()
    const message = await (await call(`/api/agent/messages/${list.data[0].id}`, one.token)).json()
    expect(message.attachments).toHaveLength(1)
    const section = message.attachments[0].section

    const file = await call(`/api/agent/messages/${message.id}/attachments/${section}`, one.token)
    expect(file.status).toBe(200)
    expect(await file.text()).toBe("<script>alert(1)</script>")
    // Whatever the sender called it, it is a download, never a page.
    expect(file.headers.get("content-type")).toBe("application/octet-stream")
    expect(file.headers.get("content-disposition")).toContain("attachment")

    const stolen = await call(`/api/agent/messages/${message.id}/attachments/${section}`, two.token)
    expect(stolen.status).toBe(404)
  })
})

describe("sending", () => {
  const post = (token: string, body: unknown) =>
    call("/api/agent/send", token, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  const enable = (agent: Agent, on: boolean) =>
    db().execute({
      text: "UPDATE agents SET can_send = $2 WHERE id = $1",
      values: [agent.id, on],
    })

  test("is refused until it is turned on", async () => {
    const res = await post(two.token, { to: ["x@far.invalid"], subject: "s", text: "t" })
    expect(res.status).toBe(403)
  })

  test("a reply goes to the sender", async () => {
    await enable(one.agent, true)
    await mail(one.email, "Question", "Reply to confirm.", "noreply@shop.invalid")
    const list = await (await call("/api/agent/messages?subject=question", one.token)).json()

    const res = await post(one.token, { reply_to_message_id: list.data[0].id, text: "Confirmed." })
    expect(res.status).toBe(202)

    const queued = await db().one<{ rcpt_to: string }>({
      text: "SELECT rcpt_to FROM deliveries WHERE address_id = $1 ORDER BY created_at DESC LIMIT 1",
      values: [one.id],
    })
    expect(queued?.rcpt_to).toBe("noreply@shop.invalid")
  })

  test("a message with nobody to send to, or no subject, is refused", async () => {
    await enable(one.agent, true)
    expect((await post(one.token, { subject: "s", text: "t" })).status).toBe(400)
    expect((await post(one.token, { to: ["x@far.invalid"], text: "t" })).status).toBe(400)
  })

  test("is capped per mailbox per day", async () => {
    await enable(one.agent, true)
    await db().execute({
      text: `INSERT INTO mail_log (user_id, domain_id, address_id, direction, status, mail_from, rcpt_to, code)
             SELECT $1, $2, $3, 'outbound', 'accepted', 'a@b.invalid', 'r@far.invalid', 250
               FROM generate_series(1, 50)`,
      values: [userId, domain.id, one.id],
    })
    const res = await post(one.token, { to: ["x@far.invalid"], subject: "s", text: "t" })
    expect(res.status).toBe(429)
    expect((await res.json()).name).toBe("daily_quota_exceeded")
  })
})

describe("the panel's routes", () => {
  test("an agent token cannot list, create, or delete agents", async () => {
    expect((await call("/api/agents", one.token)).status).toBe(401)
    expect((await call("/api/agents", one.token, { method: "POST", body: "{}" })).status).toBe(401)
  })
})
