import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { createAddress, inboxOf } from "../src/addresses/index.ts"
import { db } from "../src/db/index.ts"
import { createPop3Session, type Pop3Session } from "../src/pop3/session/index.ts"
import { type Domain, users } from "../src/schema/index.ts"
import { deliver, messagesIn } from "../src/store/index.ts"

const suffix = Math.random().toString(36).slice(2, 8)
const domainName = `pop-${suffix}.invalid`
const password = "hunter2hunter2"

let userId = ""
let domain: Domain

const sample = (subject: string) =>
  [
    "From: Sender <sender@far-away.invalid>",
    `Subject: ${subject}`,
    `Message-ID: <${subject}-${suffix}@far-away.invalid>`,
    "Date: Mon, 10 Aug 2026 12:00:00 +0000",
    "",
    `Body of ${subject}.`,
    "Second body line.",
    "Third body line.",
    "",
  ].join("\r\n")

const open = (): { session: Pop3Session; send: (line: string) => Promise<string> } => {
  const session = createPop3Session({
    isSecure: () => true,
    remoteIp: "203.0.113.9",
  })
  return { session, send: (line: string) => session.feed(`${line}\r\n`) }
}

const mailboxWith = async (label: string, count: number) => {
  const { address } = await createAddress({
    domainId: domain.id,
    localPart: label,
    type: "standard",
    password,
  })
  const inbox = await inboxOf(address.id)
  for (let i = 1; i <= count; i++) {
    await deliver({ addressId: address.id, folderId: inbox.id, raw: sample(`msg${i}`) })
  }
  return { address, inbox, email: `${label}@${domainName}` }
}

const loggedIn = async (email: string) => {
  const client = open()
  await client.send(`USER ${email}`)
  const out = await client.send(`PASS ${password}`)
  expect(out).toStartWith("+OK")
  return client
}

beforeAll(async () => {
  const user = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Test', $2) RETURNING id`,
    values: [`pop-owner-${suffix}@corsair.test`, `p${suffix}`],
  })
  userId = user!.id
  domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=test', 'active') RETURNING *`,
    values: [userId, domainName],
  }))!
})

afterAll(async () => {
  await db().execute(
    from(users)
      .where((q) => q("id").equals(userId))
      .del(),
  )
})

describe("greeting and capabilities", () => {
  test("greets with a unique APOP timestamp", () => {
    const a = open().session.greeting()
    const b = open().session.greeting()
    expect(a).toStartWith("+OK")
    expect(a).toMatch(/<\d+\.\d+\.[0-9a-f]+@/)
    // A reused timestamp would make an APOP digest replayable.
    expect(a).not.toBe(b)
  })

  test("CAPA lists TOP and UIDL", async () => {
    const client = open()
    const out = await client.send("CAPA")
    expect(out).toContain("TOP")
    expect(out).toContain("UIDL")
    expect(out.trimEnd()).toEndWith(".")
  })
})

describe("authentication", () => {
  test("refuses commands before login", async () => {
    const client = open()
    expect(await client.send("STAT")).toStartWith("-ERR")
  })

  test("rejects a bad password", async () => {
    const { email } = await mailboxWith(`bad-${suffix}`, 0)
    const client = open()
    await client.send(`USER ${email}`)
    expect(await client.send("PASS wrong")).toStartWith("-ERR")
  })

  test("PASS without USER is refused", async () => {
    const client = open()
    expect(await client.send("PASS whatever")).toStartWith("-ERR")
  })

  test("APOP is refused with an explanation rather than a wrong-password error", async () => {
    const client = open()
    const out = await client.send("APOP user digest")
    expect(out).toStartWith("-ERR")
    expect(out).toContain("not supported")
  })
})

describe("transaction", () => {
  test("STAT reports the count and total size", async () => {
    const { email } = await mailboxWith(`stat-${suffix}`, 3)
    const client = await loggedIn(email)
    const out = await client.send("STAT")
    expect(out).toMatch(/^\+OK 3 \d+/)
  })

  test("LIST returns a terminated multiline response", async () => {
    const { email } = await mailboxWith(`list-${suffix}`, 2)
    const client = await loggedIn(email)
    const out = await client.send("LIST")
    expect(out).toContain("1 ")
    expect(out).toContain("2 ")
    expect(out.trimEnd()).toEndWith(".")
  })

  test("LIST with an argument returns one line", async () => {
    const { email } = await mailboxWith(`list1-${suffix}`, 2)
    const client = await loggedIn(email)
    expect(await client.send("LIST 2")).toMatch(/^\+OK 2 \d+/)
    expect(await client.send("LIST 9")).toStartWith("-ERR")
  })

  test("UIDL is stable across sessions", async () => {
    const { email } = await mailboxWith(`uidl-${suffix}`, 1)
    const first = await (await loggedIn(email)).send("UIDL 1")
    const second = await (await loggedIn(email)).send("UIDL 1")
    expect(first).toBe(second)
  })

  test("RETR returns the full message with an octet count", async () => {
    const { email } = await mailboxWith(`retr-${suffix}`, 1)
    const client = await loggedIn(email)
    const out = await client.send("RETR 1")
    expect(out).toMatch(/^\+OK \d+ octets/)
    expect(out).toContain("Body of msg1.")
    expect(out.trimEnd()).toEndWith(".")
  })

  test("TOP returns the headers plus n body lines", async () => {
    const { email } = await mailboxWith(`top-${suffix}`, 1)
    const client = await loggedIn(email)
    const out = await client.send("TOP 1 1")
    expect(out).toContain("Subject: msg1")
    expect(out).toContain("Body of msg1.")
    expect(out).not.toContain("Second body line.")
  })

  test("TOP 0 returns headers only", async () => {
    const { email } = await mailboxWith(`top0-${suffix}`, 1)
    const client = await loggedIn(email)
    const out = await client.send("TOP 1 0")
    expect(out).toContain("Subject: msg1")
    expect(out).not.toContain("Body of msg1.")
  })

  test("a message body line starting with a dot is stuffed", async () => {
    const { address, email } = await mailboxWith(`dot-${suffix}`, 0)
    const inbox = await inboxOf(address.id)
    await deliver({
      addressId: address.id,
      folderId: inbox.id,
      raw: "Subject: dotted\r\n\r\n.hidden line\r\nnormal\r\n",
    })

    const client = await loggedIn(email)
    const out = await client.send("RETR 1")
    // Without stuffing, ".hidden" would end the response early and truncate the
    // message for every client.
    expect(out).toContain("\r\n..hidden line\r\n")
  })
})

describe("deletion", () => {
  test("DELE hides a message but does not remove it until QUIT", async () => {
    const { inbox, email } = await mailboxWith(`dele-${suffix}`, 2)
    const client = await loggedIn(email)

    expect(await client.send("DELE 1")).toStartWith("+OK")
    expect(await client.send("STAT")).toMatch(/^\+OK 1 /)
    expect(await client.send("RETR 1")).toStartWith("-ERR")
    // Still on disk until the session ends.
    expect(await messagesIn(inbox.id)).toHaveLength(2)

    await client.send("QUIT")
    expect(await messagesIn(inbox.id)).toHaveLength(1)
  })

  test("RSET undoes every pending deletion", async () => {
    const { inbox, email } = await mailboxWith(`rset-${suffix}`, 2)
    const client = await loggedIn(email)

    await client.send("DELE 1")
    await client.send("DELE 2")
    expect(await client.send("RSET")).toStartWith("+OK")
    expect(await client.send("STAT")).toMatch(/^\+OK 2 /)

    await client.send("QUIT")
    expect(await messagesIn(inbox.id)).toHaveLength(2)
  })

  test("a dropped connection loses nothing", async () => {
    const { inbox, email } = await mailboxWith(`drop-${suffix}`, 2)
    const client = await loggedIn(email)
    await client.send("DELE 1")
    // No QUIT — the client vanished. RFC 1939 says the deletions are forgotten.
    expect(await messagesIn(inbox.id)).toHaveLength(2)
  })

  test("numbering stays frozen for the session", async () => {
    const { email } = await mailboxWith(`frozen-${suffix}`, 3)
    const client = await loggedIn(email)
    const before = await client.send("UIDL 3")
    await client.send("DELE 1")
    // Deleting message 1 must not renumber 3 to 2.
    expect(await client.send("UIDL 3")).toBe(before)
  })
})

describe("framing", () => {
  test("handles a command split across packets", async () => {
    const client = open()
    await client.session.feed("CAP")
    expect(await client.session.feed("A\r\n")).toContain("UIDL")
  })

  test("QUIT closes", async () => {
    const client = open()
    expect(await client.send("QUIT")).toStartWith("+OK")
    expect(client.session.shouldClose()).toBe(true)
  })
})
