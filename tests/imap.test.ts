import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { createAddress, inboxOf } from "../src/addresses/index.ts"
import { db, num } from "../src/db/index.ts"
import { createImapSession, type ImapSession } from "../src/imap/session/index.ts"
import { type Domain, users } from "../src/schema/index.ts"
import { deliver, messagesIn } from "../src/store/index.ts"

/**
 * Drives a real IMAP session against a real mailbox. The protocol's sharp edges
 * — sequence renumbering after EXPUNGE, UID versus sequence addressing, literal
 * framing, partial fetches — are all things that only break against real data,
 * so none of this is mocked.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const domainName = `imap-${suffix}.invalid`
const password = "hunter2hunter2"

let userId = ""
let domain: Domain
let addressId = ""
let email = ""

const sample = (subject: string, body: string) =>
  [
    "From: Sender <sender@far-away.invalid>",
    `To: ${email}`,
    `Subject: ${subject}`,
    `Message-ID: <${subject.replace(/\W/g, "")}-${suffix}@far-away.invalid>`,
    "Date: Mon, 10 Aug 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    "--B",
    "Content-Type: text/html; charset=utf-8",
    "",
    `<p>${body}</p>`,
    "--B--",
    "",
  ].join("\r\n")

const open = (): { session: ImapSession; send: (line: string) => Promise<string> } => {
  const session = createImapSession({
    isSecure: () => true,
    remoteIp: "203.0.113.9",
    push: () => {},
  })
  return { session, send: (line: string) => session.feed(`${line}\r\n`) }
}

const login = async () => {
  const client = open()
  const out = await client.send(`a1 LOGIN "${email}" "${password}"`)
  expect(out).toContain("a1 OK")
  return client
}

beforeAll(async () => {
  const user = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Test', $2) RETURNING id`,
    values: [`imap-owner-${suffix}@corsair.test`, `i${suffix}`],
  })
  userId = user!.id

  domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=test', 'active') RETURNING *`,
    values: [userId, domainName],
  }))!

  const { address } = await createAddress({
    domainId: domain.id,
    localPart: "user",
    type: "standard",
    password,
    name: "Test User",
  })
  addressId = address.id
  email = `user@${domainName}`

  const inbox = await inboxOf(addressId)
  await deliver({ addressId, folderId: inbox.id, raw: sample("First message", "Body one.") })
  await deliver({ addressId, folderId: inbox.id, raw: sample("Second message", "Body two.") })
  await deliver({
    addressId,
    folderId: inbox.id,
    raw: sample("Third message", "Body three."),
    flags: ["\\Seen"],
  })
})

afterAll(async () => {
  await db().execute(
    from(users)
      .where((q) => q("id").equals(userId))
      .del(),
  )
})

describe("greeting and capability", () => {
  test("greets with the capability list", () => {
    const { session } = open()
    const greeting = session.greeting()
    expect(greeting).toStartWith("* OK [CAPABILITY IMAP4rev1")
    expect(greeting).toContain("IDLE")
    expect(greeting).toContain("UIDPLUS")
    expect(greeting).toContain("MOVE")
  })

  test("CAPABILITY works before login", async () => {
    const client = open()
    const out = await client.send("a1 CAPABILITY")
    expect(out).toContain("* CAPABILITY")
    expect(out).toContain("a1 OK")
  })
})

describe("authentication", () => {
  test("rejects a bad password", async () => {
    const client = open()
    const out = await client.send(`a1 LOGIN "${email}" "wrong-password"`)
    expect(out).toContain("a1 NO")
    expect(out).toContain("AUTHENTICATIONFAILED")
  })

  test("refuses commands before login", async () => {
    const client = open()
    expect(await client.send("a1 SELECT INBOX")).toContain("a1 NO")
  })

  test("accepts AUTHENTICATE PLAIN with an initial response", async () => {
    const client = open()
    const payload = Buffer.from(`\0${email}\0${password}`).toString("base64")
    expect(await client.send(`a1 AUTHENTICATE PLAIN ${payload}`)).toContain("a1 OK")
  })

  test("accepts a username sent as a literal", async () => {
    const client = open()
    const out = await client.session.feed(
      `a1 LOGIN {${email.length}}\r\n${email} "${password}"\r\n`,
    )
    expect(out).toContain("+ Ready for literal data")
    expect(out).toContain("a1 OK")
  })
})

describe("mailboxes", () => {
  test("LIST returns the special-use folders with their attributes", async () => {
    const client = await login()
    const out = await client.send('a2 LIST "" "*"')
    expect(out).toContain('* LIST (\\Inbox) "/" "INBOX"')
    expect(out).toContain("\\Sent")
    expect(out).toContain("\\Trash")
    expect(out).toContain("a2 OK")
  })

  test("LIST with an empty pattern reports the delimiter", async () => {
    const client = await login()
    const out = await client.send('a2 LIST "" ""')
    expect(out).toContain('* LIST (\\Noselect) "/" ""')
  })

  test("CREATE makes intermediate folders", async () => {
    const client = await login()
    expect(await client.send('a2 CREATE "Projects/Corsair/Notes"')).toContain("a2 OK")
    const out = await client.send('a3 LIST "" "Projects*"')
    expect(out).toContain('"Projects"')
    expect(out).toContain('"Projects/Corsair"')
    expect(out).toContain('"Projects/Corsair/Notes"')
  })

  test("RENAME moves children with the parent", async () => {
    const client = await login()
    await client.send('a2 CREATE "Old/Child"')
    expect(await client.send('a3 RENAME "Old" "New"')).toContain("a3 OK")
    const out = await client.send('a4 LIST "" "New*"')
    expect(out).toContain('"New/Child"')
  })

  test("CREATE refuses a duplicate", async () => {
    const client = await login()
    await client.send('a2 CREATE "Dupe"')
    expect(await client.send('a3 CREATE "Dupe"')).toContain("ALREADYEXISTS")
  })

  test("DELETE refuses INBOX", async () => {
    const client = await login()
    expect(await client.send("a2 DELETE INBOX")).toContain("a2 NO")
  })

  test("SUBSCRIBE and LSUB round-trip", async () => {
    const client = await login()
    await client.send('a2 CREATE "Subbed"')
    await client.send('a3 UNSUBSCRIBE "Subbed"')
    expect(await client.send('a4 LSUB "" "Subbed"')).not.toContain('"Subbed"')
    await client.send('a5 SUBSCRIBE "Subbed"')
    expect(await client.send('a6 LSUB "" "Subbed"')).toContain('"Subbed"')
  })

  test("STATUS reports the counts", async () => {
    const client = await login()
    const out = await client.send("a2 STATUS INBOX (MESSAGES UNSEEN UIDNEXT UIDVALIDITY)")
    expect(out).toContain("* STATUS")
    expect(out).toContain("MESSAGES 3")
    expect(out).toContain("UNSEEN 2")
  })
})

describe("SELECT", () => {
  test("reports the mailbox state", async () => {
    const client = await login()
    const out = await client.send("a2 SELECT INBOX")
    expect(out).toContain("* 3 EXISTS")
    expect(out).toContain("[UIDVALIDITY")
    expect(out).toContain("[UIDNEXT 4]")
    expect(out).toContain("[UNSEEN 1]")
    expect(out).toContain("a2 OK [READ-WRITE]")
  })

  test("EXAMINE opens read-only", async () => {
    const client = await login()
    expect(await client.send("a2 EXAMINE INBOX")).toContain("a2 OK [READ-ONLY]")
  })

  test("a store against a read-only mailbox is refused", async () => {
    const client = await login()
    await client.send("a2 EXAMINE INBOX")
    expect(await client.send("a3 STORE 1 +FLAGS (\\Flagged)")).toContain("a3 NO")
  })
})

describe("FETCH", () => {
  const selected = async () => {
    const client = await login()
    await client.send("a2 SELECT INBOX")
    return client
  }

  test("FLAGS, UID, and size come from the row", async () => {
    const client = await selected()
    const out = await client.send("a3 FETCH 1 (UID FLAGS RFC822.SIZE)")
    expect(out).toContain("* 1 FETCH (UID 1 FLAGS () RFC822.SIZE")
    expect(out).toContain("a3 OK")
  })

  test("ENVELOPE carries structured addresses", async () => {
    const client = await selected()
    const out = await client.send("a3 FETCH 1 ENVELOPE")
    expect(out).toContain("ENVELOPE (")
    expect(out).toContain('"First message"')
    expect(out).toContain('("Sender" NIL "sender" "far-away.invalid")')
  })

  test("BODYSTRUCTURE describes the multipart tree", async () => {
    const client = await selected()
    const out = await client.send("a3 FETCH 1 BODYSTRUCTURE")
    expect(out).toContain('"TEXT" "PLAIN"')
    expect(out).toContain('"TEXT" "HTML"')
    expect(out).toContain('"ALTERNATIVE"')
  })

  test("BODY[TEXT] returns a literal", async () => {
    const client = await selected()
    const out = await client.send("a3 FETCH 1 BODY[TEXT]")
    expect(out).toMatch(/BODY\[TEXT\] \{\d+\}/)
    expect(out).toContain("Body one.")
  })

  test("BODY[1] returns just that part", async () => {
    const client = await selected()
    const out = await client.send("a3 FETCH 1 BODY[1]")
    expect(out).toContain("Body one.")
    expect(out).not.toContain("<p>")
  })

  test("BODY[HEADER.FIELDS] returns only the named headers", async () => {
    const client = await selected()
    const out = await client.send("a3 FETCH 1 BODY[HEADER.FIELDS (SUBJECT FROM)]")
    expect(out).toContain("Subject: First message")
    expect(out).toContain("From: Sender")
    expect(out).not.toContain("Message-ID:")
  })

  test("a partial fetch returns the requested slice", async () => {
    const client = await selected()
    const out = await client.send("a3 FETCH 1 BODY[TEXT]<0.10>")
    expect(out).toMatch(/BODY\[TEXT\]<0> \{10\}/)
  })

  test("BODY[] without PEEK sets \\Seen", async () => {
    const client = await selected()
    await client.send("a3 FETCH 1 BODY[]")
    const out = await client.send("a4 FETCH 1 FLAGS")
    expect(out).toContain("\\Seen")
  })

  test("BODY.PEEK[] does not set \\Seen", async () => {
    const client = await selected()
    await client.send("a3 FETCH 2 BODY.PEEK[]")
    const out = await client.send("a4 FETCH 2 FLAGS")
    expect(out).toContain("* 2 FETCH (FLAGS ())")
  })

  test("the FAST macro expands", async () => {
    const client = await selected()
    const out = await client.send("a3 FETCH 1 FAST")
    expect(out).toContain("FLAGS")
    expect(out).toContain("INTERNALDATE")
    expect(out).toContain("RFC822.SIZE")
  })

  test("UID FETCH addresses by UID and always reports it", async () => {
    const client = await selected()
    const out = await client.send("a3 UID FETCH 2 (FLAGS)")
    expect(out).toContain("UID 2")
    expect(out).toContain("* 2 FETCH")
  })

  test("a range fetches every message in it", async () => {
    const client = await selected()
    const out = await client.send("a3 FETCH 1:* (UID)")
    expect(out).toContain("* 1 FETCH")
    expect(out).toContain("* 2 FETCH")
    expect(out).toContain("* 3 FETCH")
  })
})

describe("STORE", () => {
  test("adds, removes, and replaces flags", async () => {
    const client = await login()
    await client.send("a2 SELECT INBOX")

    expect(await client.send("a3 STORE 1 +FLAGS (\\Flagged)")).toContain("\\Flagged")
    expect(await client.send("a4 STORE 1 -FLAGS (\\Flagged)")).not.toContain("\\Flagged)")
    const out = await client.send("a5 STORE 1 FLAGS (\\Answered)")
    expect(out).toContain("FLAGS (\\Answered)")
  })

  test("the SILENT form emits no untagged FETCH", async () => {
    const client = await login()
    await client.send("a2 SELECT INBOX")
    const out = await client.send("a3 STORE 2 +FLAGS.SILENT (\\Flagged)")
    expect(out).not.toContain("* 2 FETCH")
    expect(out).toContain("a3 OK")
  })
})

describe("SEARCH", () => {
  const selected = async () => {
    const client = await login()
    await client.send("a2 SELECT INBOX")
    return client
  }

  test("ALL returns every sequence number", async () => {
    const client = await selected()
    expect(await client.send("a3 SEARCH ALL")).toContain("* SEARCH 1 2 3")
  })

  test("SUBJECT matches a substring", async () => {
    const client = await selected()
    expect(await client.send('a3 SEARCH SUBJECT "Second"')).toContain("* SEARCH 2")
  })

  test("BODY searches the decoded text", async () => {
    const client = await selected()
    expect(await client.send('a3 SEARCH BODY "Body three"')).toContain("* SEARCH 3")
  })

  test("flag criteria work", async () => {
    const client = await selected()
    const out = await client.send("a3 SEARCH SEEN")
    expect(out).toContain("* SEARCH")
    expect(out).toContain("3")
  })

  test("NOT inverts", async () => {
    const client = await selected()
    const out = await client.send("a3 SEARCH NOT SEEN")
    expect(out).toContain("* SEARCH")
    expect(out).not.toContain(" 3\r")
  })

  test("OR takes either branch", async () => {
    const client = await selected()
    const out = await client.send('a3 SEARCH OR SUBJECT "First" SUBJECT "Third"')
    expect(out).toContain("1")
    expect(out).toContain("3")
  })

  test("LARGER and SMALLER compare the size", async () => {
    const client = await selected()
    expect(await client.send("a3 SEARCH SMALLER 1000000")).toContain("* SEARCH 1 2 3")
    expect(await client.send("a4 SEARCH LARGER 1000000")).toContain("* SEARCH\r\n")
  })

  test("UID SEARCH reports UIDs", async () => {
    const client = await selected()
    expect(await client.send("a3 UID SEARCH ALL")).toContain("* SEARCH 1 2 3")
  })

  test("HEADER matches an arbitrary field", async () => {
    const client = await selected()
    const out = await client.send('a3 SEARCH HEADER "Message-ID" "Secondmessage"')
    expect(out).toContain("* SEARCH 2")
  })

  test("SORT orders by subject", async () => {
    const client = await selected()
    // "First" < "Second" < "Third", which happens to match arrival order here;
    // the reverse test below is what proves the key is actually applied.
    const out = await client.send("a3 SORT (SUBJECT) UTF-8 ALL")
    expect(out).toContain("* SORT 1 2 3")
  })

  test("SORT by a key that disagrees with arrival order", async () => {
    const client = await selected()
    const out = await client.send("a3 SORT (REVERSE SUBJECT) UTF-8 ALL")
    expect(out).toContain("* SORT 3 2 1")
  })

  test("REVERSE flips the order", async () => {
    const client = await selected()
    const out = await client.send("a3 SORT (REVERSE ARRIVAL) UTF-8 ALL")
    expect(out).toContain("* SORT 3 2 1")
  })
})

describe("APPEND", () => {
  test("stores a message and reports APPENDUID", async () => {
    const client = await login()
    const raw = sample("Appended", "Appended body.")
    const out = await client.session.feed(
      `a2 APPEND "Drafts" (\\Draft) {${raw.length}}\r\n${raw}\r\n`,
    )
    expect(out).toContain("+ Ready for literal data")
    expect(out).toContain("a2 OK [APPENDUID")
  })

  test("LITERAL+ skips the continuation", async () => {
    const client = await login()
    const raw = sample("Nonsynchronising", "No continuation.")
    const out = await client.session.feed(`a2 APPEND "Drafts" {${raw.length}+}\r\n${raw}\r\n`)
    expect(out).not.toContain("+ Ready")
    expect(out).toContain("a2 OK [APPENDUID")
  })
})

describe("COPY, MOVE, and EXPUNGE", () => {
  test("COPY reports COPYUID and leaves the source", async () => {
    const client = await login()
    await client.send("a2 SELECT INBOX")
    const out = await client.send('a3 COPY 1 "Archive"')
    expect(out).toContain("a3 OK [COPYUID")
    expect(await messagesIn((await inboxOf(addressId)).id)).toHaveLength(3)
  })

  test("EXPUNGE removes flagged messages and renumbers highest-first", async () => {
    // A separate mailbox, so the shared INBOX fixtures stay intact.
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: `expunge-${suffix}`,
      type: "standard",
      password,
    })
    const inbox = await inboxOf(address.id)
    for (const n of ["one", "two", "three"]) {
      await deliver({ addressId: address.id, folderId: inbox.id, raw: sample(n, n) })
    }

    const client = open()
    await client.send(`a1 LOGIN "expunge-${suffix}@${domainName}" "${password}"`)
    await client.send("a2 SELECT INBOX")
    await client.send("a3 STORE 1,2 +FLAGS (\\Deleted)")

    const out = await client.send("a4 EXPUNGE")
    const order = [...out.matchAll(/\* (\d+) EXPUNGE/g)].map((m) => Number(m[1]))
    expect(order).toEqual([2, 1])
    expect(out).toContain("* 1 EXISTS")

    const remaining = await messagesIn(inbox.id)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.subject).toBe("three")
  })

  test("MOVE copies then expunges in one step", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: `move-${suffix}`,
      type: "standard",
      password,
    })
    const inbox = await inboxOf(address.id)
    await deliver({ addressId: address.id, folderId: inbox.id, raw: sample("movable", "x") })

    const client = open()
    await client.send(`a1 LOGIN "move-${suffix}@${domainName}" "${password}"`)
    await client.send("a2 SELECT INBOX")
    const out = await client.send('a3 MOVE 1 "Archive"')

    expect(out).toContain("COPYUID")
    expect(out).toContain("* 1 EXPUNGE")
    expect(await messagesIn(inbox.id)).toHaveLength(0)
  })

  test("CLOSE expunges without untagged responses", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: `close-${suffix}`,
      type: "standard",
      password,
    })
    const inbox = await inboxOf(address.id)
    await deliver({ addressId: address.id, folderId: inbox.id, raw: sample("closing", "x") })

    const client = open()
    await client.send(`a1 LOGIN "close-${suffix}@${domainName}" "${password}"`)
    await client.send("a2 SELECT INBOX")
    await client.send("a3 STORE 1 +FLAGS (\\Deleted)")
    const out = await client.send("a4 CLOSE")

    expect(out).not.toContain("EXPUNGE")
    expect(out).toContain("a4 OK")
    expect(await messagesIn(inbox.id)).toHaveLength(0)
  })
})

describe("IDLE", () => {
  test("enters and leaves on DONE", async () => {
    const client = await login()
    await client.send("a2 SELECT INBOX")
    expect(await client.send("a3 IDLE")).toContain("+ idling")
    expect(client.session.isIdling()).toBe(true)
    expect(await client.send("DONE")).toContain("a3 OK")
    expect(client.session.isIdling()).toBe(false)
  })

  test("polling reports mail that arrived while idle", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: `idle-${suffix}`,
      type: "standard",
      password,
    })
    const inbox = await inboxOf(address.id)

    const client = open()
    await client.send(`a1 LOGIN "idle-${suffix}@${domainName}" "${password}"`)
    await client.send("a2 SELECT INBOX")
    await client.send("a3 IDLE")

    await deliver({ addressId: address.id, folderId: inbox.id, raw: sample("while idle", "x") })

    const out = await client.session.poll()
    expect(out).toContain("* 1 EXISTS")
  })
})

describe("framing", () => {
  test("handles a command split across packets", async () => {
    const client = open()
    await client.session.feed("a1 CAPAB")
    const out = await client.session.feed("ILITY\r\n")
    expect(out).toContain("a1 OK")
  })

  test("handles two commands in one packet", async () => {
    const client = open()
    const out = await client.session.feed("a1 CAPABILITY\r\na2 NOOP\r\n")
    expect(out).toContain("a1 OK")
    expect(out).toContain("a2 OK")
  })

  test("LOGOUT closes", async () => {
    const client = open()
    const out = await client.send("a1 LOGOUT")
    expect(out).toContain("* BYE")
    expect(client.session.shouldClose()).toBe(true)
  })

  test("an unknown command is BAD, not fatal", async () => {
    const client = await login()
    expect(await client.send("a2 NONSENSE")).toContain("a2 BAD")
    expect(await client.send("a3 NOOP")).toContain("a3 OK")
  })
})

describe("uid allocation", () => {
  test("UIDs never repeat, even after an expunge", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: `uidsafe-${suffix}`,
      type: "standard",
      password,
    })
    const inbox = await inboxOf(address.id)
    await deliver({ addressId: address.id, folderId: inbox.id, raw: sample("a", "a") })
    await deliver({ addressId: address.id, folderId: inbox.id, raw: sample("b", "b") })

    const client = open()
    await client.send(`a1 LOGIN "uidsafe-${suffix}@${domainName}" "${password}"`)
    await client.send("a2 SELECT INBOX")
    await client.send("a3 STORE 1:2 +FLAGS (\\Deleted)")
    await client.send("a4 EXPUNGE")

    await deliver({ addressId: address.id, folderId: inbox.id, raw: sample("c", "c") })
    const rows = await messagesIn(inbox.id)
    expect(num(rows[0]!.uid)).toBe(3)
  })

  test("concurrent deliveries do not collide", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: `race-${suffix}`,
      type: "standard",
      password,
    })
    const inbox = await inboxOf(address.id)

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        deliver({ addressId: address.id, folderId: inbox.id, raw: sample(`race${i}`, "x") }),
      ),
    )

    const uids = (await messagesIn(inbox.id)).map((m) => num(m.uid))
    expect(new Set(uids).size).toBe(12)
    expect(uids).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  })
})
