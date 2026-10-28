import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@wess/atlas/db/query"
import { createAddress, inboxOf } from "../src/addresses/index.ts"
import { db, num } from "../src/db/index.ts"
import { createImapSession, type ImapSession } from "../src/imap/session/index.ts"
import { type Domain, type Folder, folders, users } from "../src/schema/index.ts"
import { deliver, messagesIn, setFlags, vanishedSince } from "../src/store/index.ts"
import { enqueueJob, tick } from "../src/worker/index.ts"

/**
 * CONDSTORE and QRESYNC (RFC 7162) against real mailboxes. The point of both is
 * that a client which reconnects learns exactly what changed while it was away,
 * so every case here is two sessions: one makes changes, the other resyncs.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const domainName = `condstore-${suffix}.invalid`
const password = "hunter2hunter2"

let userId = ""
let domain: Domain
let counter = 0

const sample = (subject: string) =>
  [
    "From: Sender <sender@far-away.invalid>",
    "To: someone@example.invalid",
    `Subject: ${subject}`,
    `Message-ID: <${subject.replace(/\W/g, "")}-${suffix}@far-away.invalid>`,
    "",
    `Body of ${subject}.`,
    "",
  ].join("\r\n")

type Client = { session: ImapSession; send: (line: string) => Promise<string> }

/** A fresh mailbox holding `count` messages, and a way to log into it. */
const mailbox = async (count: number) => {
  const localPart = `box${++counter}-${suffix}`
  const { address } = await createAddress({
    domainId: domain.id,
    localPart,
    type: "standard",
    password,
  })
  const inbox = await inboxOf(address.id)
  for (let i = 1; i <= count; i++) {
    await deliver({ addressId: address.id, folderId: inbox.id, raw: sample(`m${i}`) })
  }
  const login = async (): Promise<Client> => {
    const session = createImapSession({
      isSecure: () => true,
      remoteIp: "203.0.113.20",
      push: () => {},
    })
    const send = (line: string) => session.feed(`${line}\r\n`)
    expect(await send(`a0 LOGIN "${localPart}@${domainName}" "${password}"`)).toContain("a0 OK")
    return { session, send }
  }
  const folder = async () =>
    (await db().one<Folder>(from(folders).where((q) => q("id").equals(inbox.id))))!
  return { addressId: address.id, inbox, login, folder }
}

const highestIn = (out: string): number => Number(out.match(/HIGHESTMODSEQ (\d+)/)![1])
const uidValidityIn = (out: string): number => Number(out.match(/UIDVALIDITY (\d+)/)![1])

beforeAll(async () => {
  const user = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Test', $2) RETURNING id`,
    values: [`condstore-owner-${suffix}@corsair.test`, `c${suffix}`],
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

describe("advertising and enabling", () => {
  test("both capabilities are advertised", async () => {
    const box = await mailbox(0)
    const client = await box.login()
    const out = await client.send("a1 CAPABILITY")
    expect(out).toContain(" CONDSTORE")
    expect(out).toContain(" QRESYNC")
  })

  test("ENABLE lists only what was newly enabled", async () => {
    const box = await mailbox(0)
    const client = await box.login()
    expect(await client.send("a1 ENABLE QRESYNC")).toContain("* ENABLED QRESYNC\r\n")
    // QRESYNC already turned CONDSTORE on.
    expect(await client.send("a2 ENABLE CONDSTORE QRESYNC")).toContain("* ENABLED\r\n")
  })

  test("SELECT with QRESYNC parameters is refused until QRESYNC is enabled", async () => {
    const box = await mailbox(1)
    const client = await box.login()
    expect(await client.send("a1 SELECT INBOX (QRESYNC (1 1))")).toContain("a1 BAD")
  })

  test("SELECT (CONDSTORE) reports HIGHESTMODSEQ and turns on MODSEQ in FETCH", async () => {
    const box = await mailbox(2)
    const client = await box.login()
    const selected = await client.send("a1 SELECT INBOX (CONDSTORE)")
    expect(selected).toContain("[HIGHESTMODSEQ ")
    expect(selected).toContain("a1 OK [READ-WRITE]")
    const out = await client.send("a2 STORE 1 +FLAGS (\\Flagged)")
    expect(out).toMatch(/\* 1 FETCH \(FLAGS \(\\Flagged\) UID 1 MODSEQ \(\d+\)\)/)
  })

  test("STATUS reports HIGHESTMODSEQ", async () => {
    const box = await mailbox(1)
    const client = await box.login()
    const folder = await box.folder()
    const out = await client.send("a1 STATUS INBOX (HIGHESTMODSEQ MESSAGES)")
    expect(out).toContain(`HIGHESTMODSEQ ${num(folder.highest_modseq)}`)
  })
})

describe("modseq allocation", () => {
  test("every flag change moves the message past the folder's old high-water mark", async () => {
    const box = await mailbox(2)
    const before = num((await box.folder()).highest_modseq)
    const [first] = await messagesIn(box.inbox.id)
    const modseq = await setFlags(first!.id, box.inbox.id, ["\\Seen"])
    expect(num(modseq!)).toBeGreaterThan(before)
    expect(num((await box.folder()).highest_modseq)).toBe(num(modseq!))
    const [after] = await messagesIn(box.inbox.id)
    expect(num(after!.modseq)).toBe(num(modseq!))
  })

  test("concurrent flag changes get distinct, gap-free modseqs", async () => {
    const box = await mailbox(12)
    const before = num((await box.folder()).highest_modseq)
    const rows = await messagesIn(box.inbox.id)
    const written = await Promise.all(
      rows.map((row) => setFlags(row.id, box.inbox.id, ["\\Flagged"])),
    )
    const values = written.map((v) => num(v!)).sort((a, b) => a - b)
    expect(new Set(values).size).toBe(rows.length)
    expect(values[0]).toBe(before + 1)
    expect(values.at(-1)).toBe(before + rows.length)
    expect(num((await box.folder()).highest_modseq)).toBe(before + rows.length)
  })

  test("concurrent +FLAGS from two clients keep both flags", async () => {
    const box = await mailbox(1)
    const a = await box.login()
    const b = await box.login()
    await a.send("a1 SELECT INBOX")
    await b.send("b1 SELECT INBOX")
    await Promise.all([
      a.send("a2 STORE 1 +FLAGS (\\Flagged)"),
      b.send("b2 STORE 1 +FLAGS (\\Seen)"),
    ])
    const [row] = await messagesIn(box.inbox.id)
    expect([...(row!.flags ?? [])].sort()).toEqual(["\\Flagged", "\\Seen"])
  })
})

describe("conditional STORE", () => {
  test("UNCHANGEDSINCE refuses a message another client changed and reports it MODIFIED", async () => {
    const box = await mailbox(3)
    const a = await box.login()
    const b = await box.login()
    const selected = await a.send("a1 SELECT INBOX (CONDSTORE)")
    const seen = highestIn(selected)
    await b.send("b1 SELECT INBOX")
    await b.send("b2 STORE 2 +FLAGS (\\Seen)")

    const out = await a.send(`a2 STORE 1:3 (UNCHANGEDSINCE ${seen}) +FLAGS.SILENT (\\Deleted)`)
    expect(out).toContain("a2 OK [MODIFIED 2]")
    // .SILENT still carries the new MODSEQ for the ones that were stored.
    expect(out).toMatch(/\* 1 FETCH \(UID 1 MODSEQ \(\d+\)\)/)
    expect(out).toMatch(/\* 3 FETCH \(UID 3 MODSEQ \(\d+\)\)/)
    expect(out).not.toContain("* 2 FETCH")

    const rows = await messagesIn(box.inbox.id)
    expect(rows[0]!.flags).toContain("\\Deleted")
    expect(rows[1]!.flags).toEqual(["\\Seen"])
    expect(rows[2]!.flags).toContain("\\Deleted")
  })

  test("UID STORE reports MODIFIED by UID", async () => {
    const box = await mailbox(2)
    const a = await box.login()
    await a.send("a1 SELECT INBOX")
    const out = await a.send("a2 UID STORE 1:2 (UNCHANGEDSINCE 0) +FLAGS (\\Seen)")
    expect(out).toContain("a2 OK [MODIFIED 1:2]")
  })
})

describe("FETCH and SEARCH by modseq", () => {
  test("FETCH CHANGEDSINCE returns only what changed, with MODSEQ", async () => {
    const box = await mailbox(3)
    const a = await box.login()
    const seen = highestIn(await a.send("a1 SELECT INBOX"))
    await a.send("a2 STORE 3 +FLAGS (\\Answered)")
    const out = await a.send(`a3 FETCH 1:* (FLAGS) (CHANGEDSINCE ${seen})`)
    expect(out).toMatch(/\* 3 FETCH \(FLAGS \(\\Answered\) MODSEQ \(\d+\)\)/)
    expect(out).not.toContain("* 1 FETCH")
    expect(out).not.toContain("* 2 FETCH")
    expect(out).toContain("a3 OK")
  })

  test("SEARCH MODSEQ answers with the highest modseq among the hits", async () => {
    const box = await mailbox(3)
    const a = await box.login()
    const seen = highestIn(await a.send("a1 SELECT INBOX (CONDSTORE)"))
    const stored = await a.send("a2 STORE 2 +FLAGS (\\Flagged)")
    const modseq = Number(stored.match(/MODSEQ \((\d+)\)/)?.[1] ?? 0)
    const out = await a.send(`a3 SEARCH MODSEQ ${seen + 1}`)
    expect(out).toContain(`* SEARCH 2 (MODSEQ ${modseq})`)
    // The entry-name form parses too.
    const named = await a.send(`a4 UID SEARCH MODSEQ "/flags/\\\\flagged" all ${seen + 1}`)
    expect(named).toContain(`* SEARCH 2 (MODSEQ ${modseq})`)
    expect(await a.send(`a5 SEARCH MODSEQ ${modseq + 1}`)).toContain("* SEARCH\r\n")
  })
})

describe("QRESYNC", () => {
  test("a reconnecting client is told what changed and what vanished", async () => {
    const box = await mailbox(5)
    const old = await box.login()
    await old.send("a1 ENABLE QRESYNC")
    const selected = await old.send("a2 SELECT INBOX")
    const uidValidity = uidValidityIn(selected)
    const seen = highestIn(selected)
    await old.send("a3 LOGOUT")

    // While it is away: a flag change on 3, and 1 and 4 expunged.
    const other = await box.login()
    await other.send("b1 SELECT INBOX")
    await other.send("b2 STORE 3 +FLAGS (\\Flagged)")
    await other.send("b3 STORE 1,4 +FLAGS (\\Deleted)")
    await other.send("b4 EXPUNGE")

    const back = await box.login()
    await back.send("c1 ENABLE QRESYNC")
    const out = await back.send(`c2 SELECT INBOX (QRESYNC (${uidValidity} ${seen}))`)
    expect(out).toContain("* 3 EXISTS")
    // UID 3 is now sequence 2.
    expect(out).toMatch(/\* 2 FETCH \(UID 3 FLAGS \(\\Flagged\) MODSEQ \(\d+\)\)/)
    expect(out).toContain("* VANISHED (EARLIER) 1,4\r\n")
    expect(out).not.toContain("UID 2 FLAGS")
    expect(out).not.toContain("UID 5 FLAGS")
    expect(out).toContain("c2 OK [READ-WRITE]")
    expect(highestIn(out)).toBeGreaterThan(seen)
  })

  test("known UIDs restrict the report", async () => {
    const box = await mailbox(4)
    const a = await box.login()
    await a.send("a1 ENABLE QRESYNC")
    const selected = await a.send("a2 SELECT INBOX")
    const seen = highestIn(selected)
    await a.send("a3 STORE 1,3 +FLAGS (\\Deleted \\Seen)")
    await a.send("a4 EXPUNGE")

    const b = await box.login()
    await b.send("b1 ENABLE QRESYNC")
    const out = await b.send(`b2 EXAMINE INBOX (QRESYNC (${uidValidityIn(selected)} ${seen} 2:4))`)
    expect(out).toContain("* VANISHED (EARLIER) 3\r\n")
  })

  test("a changed UIDVALIDITY gets a plain SELECT", async () => {
    const box = await mailbox(2)
    const a = await box.login()
    await a.send("a1 ENABLE QRESYNC")
    await a.send("a2 SELECT INBOX")
    await a.send("a3 STORE 1 +FLAGS (\\Deleted)")
    await a.send("a4 EXPUNGE")
    const out = await a.send("a5 SELECT INBOX (QRESYNC (1 1))")
    expect(out).not.toContain("VANISHED")
    expect(out).not.toContain("FETCH")
    expect(out).toContain("* OK [CLOSED]")
  })

  test("UID FETCH CHANGEDSINCE VANISHED reports expunges inside the set", async () => {
    const box = await mailbox(4)
    const a = await box.login()
    await a.send("a1 ENABLE QRESYNC")
    const seen = highestIn(await a.send("a2 SELECT INBOX"))
    const b = await box.login()
    await b.send("b1 SELECT INBOX")
    await b.send("b2 STORE 2 +FLAGS (\\Deleted)")
    await b.send("b3 EXPUNGE")
    await b.send("b4 UID STORE 3 +FLAGS (\\Seen)")

    // Synced first, so the sequence numbers below are the server's current ones.
    await a.send("a3 NOOP")
    const out = await a.send(`a4 UID FETCH 1:* (FLAGS) (CHANGEDSINCE ${seen} VANISHED)`)
    expect(out).toContain("* VANISHED (EARLIER) 2\r\n")
    expect(out).toMatch(/\* 2 FETCH \(UID 3 FLAGS \(\\Seen\) MODSEQ \(\d+\)\)/)
    expect(out).not.toContain("UID 1 FLAGS")

    expect(await a.send(`a5 FETCH 1:* (FLAGS) (CHANGEDSINCE ${seen} VANISHED)`)).toContain("a5 BAD")
  })

  test("a live session hears VANISHED instead of EXPUNGE, and MODSEQ on flag changes", async () => {
    const box = await mailbox(3)
    const a = await box.login()
    await a.send("a1 ENABLE QRESYNC")
    await a.send("a2 SELECT INBOX")
    const b = await box.login()
    await b.send("b1 SELECT INBOX")
    await b.send("b2 STORE 1,2 +FLAGS (\\Deleted)")
    await b.send("b3 STORE 3 +FLAGS (\\Flagged)")
    await b.send("b4 EXPUNGE")

    const out = await a.send("a3 NOOP")
    expect(out).toContain("* VANISHED 1:2\r\n")
    expect(out).not.toContain("EXPUNGE")
    expect(out).toMatch(/\* 1 FETCH \(UID 3 FLAGS \(\\Flagged\) MODSEQ \(\d+\)\)/)

    // A client that never enabled anything still gets EXPUNGE, highest first.
    const box2 = await mailbox(3)
    const plain = await box2.login()
    await plain.send("p1 SELECT INBOX")
    const writer = await box2.login()
    await writer.send("w1 SELECT INBOX")
    await writer.send("w2 STORE 1,2 +FLAGS (\\Deleted)")
    await writer.send("w3 EXPUNGE")
    const noop = await plain.send("p2 NOOP")
    expect([...noop.matchAll(/\* (\d+) EXPUNGE/g)].map((m) => Number(m[1]))).toEqual([2, 1])
    expect(noop).not.toContain("VANISHED")
    expect(noop).not.toContain("MODSEQ")
  })

  test("past the retention sweep, every UID that is not live is reported", async () => {
    const box = await mailbox(6)
    const a = await box.login()
    await a.send("a1 ENABLE QRESYNC")
    const selected = await a.send("a2 SELECT INBOX")
    const seen = highestIn(selected)
    await a.send("a3 STORE 2,5 +FLAGS (\\Deleted)")
    await a.send("a4 EXPUNGE")

    // Pretend the sweep removed those tombstones.
    await db().execute({
      text: "DELETE FROM message_tombstones WHERE folder_id = $1",
      values: [box.inbox.id],
    })
    await db().execute({
      text: "UPDATE folders SET vanished_floor = highest_modseq WHERE id = $1",
      values: [box.inbox.id],
    })

    const uv = uidValidityIn(selected)
    const b = await box.login()
    await b.send("b1 ENABLE QRESYNC")
    const out = await b.send(`b2 EXAMINE INBOX (QRESYNC (${uv} ${seen}))`)
    expect(out).toContain("* VANISHED (EARLIER) 2,5\r\n")

    // seq-match: the client says its message 3 is UID 4, and so is ours. Both
    // sides then hold the same messages up to UID 4, so only 5 is left.
    const c = await box.login()
    await c.send("c1 ENABLE QRESYNC")
    const trimmed = await c.send(`c2 EXAMINE INBOX (QRESYNC (${uv} ${seen} 1:6 (1,3 1,4)))`)
    expect(trimmed).toContain("* VANISHED (EARLIER) 5\r\n")
  })
})

describe("retention", () => {
  test("the sweep records how far it reached, so QRESYNC knows to fall back", async () => {
    const box = await mailbox(1)
    await db().execute({
      text: `INSERT INTO message_tombstones (folder_id, uid, modseq, created_at)
             VALUES ($1, 99, 41, now() - interval '40 days'),
                    ($1, 98, 40, now() - interval '40 days'),
                    ($1, 97, 50, now())`,
      values: [box.inbox.id],
    })
    await enqueueJob({ kind: "retention.sweep", payload: {} })
    await tick()
    expect(num((await box.folder()).vanished_floor)).toBe(41)
    expect(await vanishedSince(box.inbox.id, 40n)).toEqual({ uids: [97], complete: false })
    expect(await vanishedSince(box.inbox.id, 41n)).toEqual({ uids: [97], complete: true })
  })
})
