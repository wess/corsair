/**
 * A real mail round trip over real sockets.
 *
 *   bun run test:mailflow
 *
 * Starts every listener in-process, delivers a message over SMTP, and reads it
 * back over IMAP and POP3. The unit suites drive the session state machines
 * directly; this is the one that proves the sockets, the TLS upgrade, the
 * store, and the protocol layers are actually wired to each other.
 *
 * Needs Postgres and a certificate at TLS_CERT_PATH / TLS_KEY_PATH.
 */

import { from } from "@atlas/db"
import { createAddress } from "../src/addresses/index.ts"
import { config } from "../src/config/index.ts"
import { closeDb, db } from "../src/db/index.ts"
import { type Domain, users } from "../src/schema/index.ts"

const suffix = Math.random().toString(36).slice(2, 8)
const domainName = `flow-${suffix}.invalid`
const password = "mailflow-password-1234"

let passed = 0
let failed = 0

const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    passed++
    console.log(`  ok    ${label}`)
    return
  }
  failed++
  console.error(`  FAIL  ${label}`)
  if (detail !== undefined) console.error(`        ${String(detail).slice(0, 400)}`)
}

const section = (name: string) => console.log(`\n${name}`)

/** A line-oriented client that collects everything the server says. */
const client = async (port: number, tls: boolean) => {
  let buffer = ""
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    ...(tls ? { tls: { rejectUnauthorized: false } } : {}),
    socket: {
      data(_s: unknown, data: Uint8Array) {
        buffer += Buffer.from(data).toString("latin1")
      },
    } as never,
  })

  const wait = async (ms = 400) => {
    await Bun.sleep(ms)
    const out = buffer
    buffer = ""
    return out
  }

  return {
    greeting: () => wait(600),
    send: async (line: string, ms = 400) => {
      socket.write(`${line}\r\n`)
      return wait(ms)
    },
    raw: async (payload: string, ms = 500) => {
      socket.write(payload)
      return wait(ms)
    },
    close: () => socket.end(),
  }
}

const run = async () => {
  section("setup")
  const { startSmtp } = await import("../src/smtp/index.ts")
  const { startImap } = await import("../src/imap/index.ts")
  const { startPop3 } = await import("../src/pop3/index.ts")

  await startSmtp()
  await startImap()
  await startPop3()
  await Bun.sleep(400)

  const hasTls = Boolean(config.tls.certPath && config.tls.keyPath)
  check("TLS is configured (needed for AUTH and LOGIN)", hasTls)

  const user = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Flow', $2) RETURNING id`,
    values: [`flow-${suffix}@corsair.test`, `f${suffix}`],
  })
  const domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=flow', 'active') RETURNING *`,
    values: [user!.id, domainName],
  }))!

  await createAddress({
    domainId: domain.id,
    localPart: "inbox",
    type: "standard",
    password,
    name: "Flow Test",
  })
  await createAddress({
    domainId: domain.id,
    localPart: "forwarded",
    type: "alias",
    destinations: [`inbox@${domainName}`],
  })
  check("fixtures created", true)

  const email = `inbox@${domainName}`
  const subject = `Round trip ${suffix}`

  // ------------------------------------------------------------------ SMTP --

  section("SMTP — receiving on the MX port")
  const mx = await client(config.smtp.mxPort, false)
  const greeting = await mx.greeting()
  check("greets with ESMTP", greeting.startsWith("220 ") && greeting.includes("ESMTP"), greeting)

  const ehlo = await mx.send("EHLO tester.invalid")
  check("advertises SIZE", ehlo.includes("250-SIZE"), ehlo)
  check("advertises STARTTLS", ehlo.includes("STARTTLS"), ehlo)
  check("does not advertise AUTH before TLS", !ehlo.includes("AUTH"), ehlo)

  const relay = await mx.send("MAIL FROM:<sender@far.invalid>")
  check("accepts the sender", relay.startsWith("250 "), relay)

  const denied = await mx.send("RCPT TO:<someone@not-hosted.invalid>")
  check("refuses to relay", denied.startsWith("550 "), denied)

  const accepted = await mx.send(`RCPT TO:<${email}>`)
  check("accepts a hosted recipient", accepted.startsWith("250 "), accepted)

  const data = await mx.send("DATA")
  check("opens the data phase", data.startsWith("354 "), data)

  const message = [
    "From: Sender <sender@far.invalid>",
    `To: ${email}`,
    `Subject: ${subject}`,
    `Message-ID: <${suffix}@far.invalid>`,
    "Date: Mon, 10 Aug 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Plain body over a real socket.",
    "--B",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>HTML body over a real socket.</p>",
    "--B--",
    "",
    ".",
    "",
  ].join("\r\n")

  const queued = await mx.raw(message, 2500)
  check("accepts the message", queued.startsWith("250 "), queued)

  const forwarded = await mx.send(`MAIL FROM:<sender@far.invalid>`)
  check("starts a second transaction", forwarded.startsWith("250 "), forwarded)
  const aliasRcpt = await mx.send(`RCPT TO:<forwarded@${domainName}>`)
  check("accepts an alias recipient", aliasRcpt.startsWith("250 "), aliasRcpt)
  await mx.send("RSET")
  await mx.send("QUIT")
  mx.close()

  // ------------------------------------------------------------------ IMAP --

  section("IMAP — reading it back")
  const imap = await client(config.imap.tlsPort, true)
  const imapGreeting = await imap.greeting()
  check("greets with a capability list", imapGreeting.includes("IMAP4rev1"), imapGreeting)
  check(
    "advertises IDLE and UIDPLUS",
    imapGreeting.includes("IDLE") && imapGreeting.includes("UIDPLUS"),
  )

  const login = await imap.send(`a1 LOGIN "${email}" "${password}"`, 900)
  check("accepts the mailbox password over TLS", login.includes("a1 OK"), login)

  const badLogin = await (async () => {
    const other = await client(config.imap.tlsPort, true)
    await other.greeting()
    const out = await other.send(`a1 LOGIN "${email}" "wrong-password"`, 900)
    other.close()
    return out
  })()
  check("rejects a wrong password", badLogin.includes("a1 NO"), badLogin)

  const list = await imap.send('a2 LIST "" "*"')
  check("lists the special-use folders", list.includes("\\Inbox") && list.includes("\\Sent"), list)

  const select = await imap.send("a3 SELECT INBOX")
  check("SELECT reports the message", select.includes("1 EXISTS"), select)
  check("SELECT reports UIDVALIDITY", select.includes("UIDVALIDITY"), select)

  const envelope = await imap.send("a4 FETCH 1 (ENVELOPE RFC822.SIZE FLAGS)")
  check("ENVELOPE carries the subject", envelope.includes(subject), envelope)
  check("the size is reported", /RFC822\.SIZE \d+/.test(envelope), envelope)

  const structure = await imap.send("a5 FETCH 1 BODYSTRUCTURE")
  check(
    "BODYSTRUCTURE describes both alternatives",
    structure.includes('"PLAIN"') && structure.includes('"HTML"'),
    structure,
  )

  const body = await imap.send("a6 FETCH 1 BODY.PEEK[1]", 700)
  check("the plain part fetches", body.includes("Plain body over a real socket."), body)

  const headerFields = await imap.send("a7 FETCH 1 BODY.PEEK[HEADER.FIELDS (SUBJECT)]", 700)
  check(
    "a header subset fetches",
    headerFields.includes(`Subject: ${subject}`) && !headerFields.includes("Message-ID"),
    headerFields,
  )

  const search = await imap.send(`a8 SEARCH SUBJECT "${suffix}"`)
  check("SEARCH finds it", search.includes("* SEARCH 1"), search)

  const stampReceived = await imap.send("a9 FETCH 1 BODY.PEEK[HEADER]", 700)
  check(
    "a Received header was stamped on delivery",
    stampReceived.includes("Received: from"),
    stampReceived.slice(0, 200),
  )
  check(
    "authentication results were recorded",
    stampReceived.includes("Authentication-Results:"),
    stampReceived.slice(0, 200),
  )

  const store = await imap.send("a10 STORE 1 +FLAGS (\\Flagged)")
  check("STORE sets a flag", store.includes("\\Flagged"), store)

  const idle = await imap.send("a11 IDLE")
  check("IDLE is entered", idle.includes("+ idling"), idle)
  const doneIdle = await imap.send("DONE")
  check("IDLE ends on DONE", doneIdle.includes("a11 OK"), doneIdle)

  await imap.send("a12 LOGOUT")
  imap.close()

  // ------------------------------------------------------------------ POP3 --

  section("POP3 — the same mailbox")
  const pop = await client(config.pop3.tlsPort, true)
  const popGreeting = await pop.greeting()
  check("greets", popGreeting.startsWith("+OK"), popGreeting)

  const capa = await pop.send("CAPA")
  check("CAPA lists TOP and UIDL", capa.includes("TOP") && capa.includes("UIDL"), capa)

  await pop.send(`USER ${email}`)
  const pass = await pop.send(`PASS ${password}`, 900)
  check("signs in", pass.startsWith("+OK"), pass)

  const stat = await pop.send("STAT")
  check("STAT reports one message", /^\+OK 1 \d+/.test(stat), stat)

  const retr = await pop.send("RETR 1", 800)
  check("RETR returns the message", retr.includes(subject), retr.slice(0, 200))
  check("the response is dot-terminated", retr.trimEnd().endsWith("."), retr.slice(-80))

  const top = await pop.send("TOP 1 0", 700)
  check(
    "TOP returns headers only",
    top.includes(subject) && !top.includes("Plain body"),
    top.slice(0, 200),
  )

  await pop.send("QUIT")
  pop.close()

  // --------------------------------------------------------------- cleanup --

  section("cleanup")
  await db().execute(
    from(users)
      .where((q) => q("id").equals(user!.id))
      .del(),
  )
  check("fixtures removed", true)

  console.log(`\n${passed} passed, ${failed} failed`)
  await closeDb()
  process.exit(failed ? 1 : 0)
}

await run()
