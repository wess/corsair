/**
 * JMAP, end to end against a running server.
 *
 *   bun run test:jmap
 *
 * Speaks the protocol the way a real client does: discover the session, then
 * batch method calls with back-references rather than making one request per
 * step.
 */

import { from } from "@atlas/db"
import { createAddress } from "../src/addresses/index.ts"
import { closeDb, db } from "../src/db/index.ts"
import { type Domain, users } from "../src/schema/index.ts"

const BASE = process.env.CORSAIR_URL ?? "http://localhost:3000"

let auth = ""
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
  if (detail !== undefined) console.error(`        ${JSON.stringify(detail).slice(0, 400)}`)
}

const section = (name: string) => console.log(`\n${name}`)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** One JMAP request carrying any number of method calls. */
const rpc = async (
  methodCalls: [string, Record<string, unknown>, string][],
  attempt = 0,
): Promise<any> => {
  const res = await fetch(`${BASE}/jmap`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: auth },
    body: JSON.stringify({
      using: [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
        "urn:ietf:params:jmap:submission",
      ],
      methodCalls,
    }),
  })
  if (res.status === 429 && attempt < 8) {
    await sleep(1000)
    return rpc(methodCalls, attempt + 1)
  }
  return res.json()
}

const responseFor = (result: any, callId: string) =>
  (result.methodResponses ?? []).find((r: any[]) => r[2] === callId)

const run = async () => {
  const suffix = Math.random().toString(36).slice(2, 8)
  const domainName = `jmap-${suffix}.invalid`
  const password = "jmap-password-1234"
  const email = `me@${domainName}`
  auth = `Basic ${Buffer.from(`${email}:${password}`).toString("base64")}`

  section("setup")
  const user = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'JMAP', $2) RETURNING id`,
    values: [`jmap-owner-${suffix}@corsair.test`, `j${suffix}`],
  })
  const domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=jmap', 'active') RETURNING *`,
    values: [user!.id, domainName],
  }))!
  await createAddress({
    domainId: domain.id,
    localPart: "me",
    type: "standard",
    password,
    name: "Me",
  })

  const { handleMessage } = await import("../src/smtp/inbound/index.ts")
  for (const subject of [`First ${suffix}`, `Second ${suffix}`, `Third ${suffix}`]) {
    await handleMessage(
      {
        helo: "far.invalid",
        mailFrom: "sender@far.invalid",
        rcptTo: [email],
        size: null,
        smtputf8: false,
      },
      [
        "From: Sender <sender@far.invalid>",
        `To: ${email}`,
        `Subject: ${subject}`,
        `Message-ID: <${subject.replace(/\W/g, "")}@far.invalid>`,
        "Date: Mon, 10 Aug 2026 12:00:00 +0000",
        "Content-Type: text/plain; charset=utf-8",
        "",
        `Body of ${subject}.`,
        "",
      ].join("\r\n"),
      { remoteIp: "203.0.113.9", helo: "far.invalid" },
    )
  }
  check("fixtures created and three messages delivered", true)

  section("session resource")
  const anonymous = await fetch(`${BASE}/.well-known/jmap`)
  check("an unauthenticated caller is challenged", anonymous.status === 401, anonymous.status)
  check(
    "with a WWW-Authenticate header",
    (anonymous.headers.get("www-authenticate") ?? "").includes("Basic"),
  )

  const sessionRes = await fetch(`${BASE}/.well-known/jmap`, { headers: { authorization: auth } })
  const session = await sessionRes.json()
  check("the session resource loads", sessionRes.status === 200, sessionRes.status)
  check(
    "core capability is advertised",
    "urn:ietf:params:jmap:core" in (session.capabilities ?? {}),
  )
  check(
    "mail capability is advertised",
    "urn:ietf:params:jmap:mail" in (session.capabilities ?? {}),
  )
  check(
    "submission capability is advertised",
    "urn:ietf:params:jmap:submission" in (session.capabilities ?? {}),
  )
  check("the username is the mailbox", session.username === email, session.username)
  check("an apiUrl is given", String(session.apiUrl ?? "").endsWith("/jmap"), session.apiUrl)
  check(
    "a primary mail account is named",
    Boolean(session.primaryAccounts?.["urn:ietf:params:jmap:mail"]),
  )

  const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"]

  section("Core/echo")
  const echo = await rpc([["Core/echo", { hello: "world" }, "c0"]])
  check("echo returns its arguments", responseFor(echo, "c0")?.[1]?.hello === "world", echo)

  const unknown = await rpc([["Nonsense/get", {}, "c1"]])
  check(
    "an unknown method is an error, not a crash",
    responseFor(unknown, "c1")?.[0] === "error",
    unknown,
  )
  check(
    "and the error names the problem",
    responseFor(unknown, "c1")?.[1]?.type === "unknownMethod",
  )

  const wrongAccount = await rpc([["Mailbox/get", { accountId: "not-mine" }, "c2"]])
  check(
    "another account id is refused",
    responseFor(wrongAccount, "c2")?.[1]?.type === "accountNotFound",
    wrongAccount,
  )

  section("Mailbox")
  const mailboxes = await rpc([["Mailbox/get", { accountId, ids: null }, "m0"]])
  const list = responseFor(mailboxes, "m0")?.[1]?.list ?? []
  check("mailboxes are listed", list.length >= 6, list.length)

  const inbox = list.find((m: any) => m.role === "inbox")
  check(
    "the inbox has a role",
    Boolean(inbox),
    list.map((m: any) => m.role),
  )
  check("with three messages", inbox?.totalEmails === 3, inbox)
  check("all unread", inbox?.unreadEmails === 3, inbox)
  check("and rights", inbox?.myRights?.mayReadItems === true)
  check("a system mailbox may not be deleted", inbox?.myRights?.mayDelete === false)

  const createMailbox = await rpc([
    ["Mailbox/set", { accountId, create: { new: { name: `Project ${suffix}` } } }, "m1"],
  ])
  const createdId = responseFor(createMailbox, "m1")?.[1]?.created?.new?.id
  check("a mailbox can be created", Boolean(createdId), createMailbox)

  section("Email/query and back-references")
  // The whole point of JMAP: query and fetch in one round trip, with the second
  // call taking its ids from the first.
  const batched = await rpc([
    ["Email/query", { accountId, filter: { inMailbox: inbox.id }, limit: 10 }, "q0"],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q0", name: "Email/query", path: "/ids" },
        properties: ["id", "subject", "keywords", "from", "preview"],
      },
      "g0",
    ],
  ])

  const queried = responseFor(batched, "q0")?.[1]
  const fetched = responseFor(batched, "g0")?.[1]
  check("the query returns ids", queried?.ids?.length === 3, queried)
  check("the back-reference resolved", fetched?.list?.length === 3, fetched?.list?.length)
  check(
    "and carried the requested properties",
    Boolean(fetched?.list?.[0]?.subject) && Boolean(fetched?.list?.[0]?.from),
    fetched?.list?.[0],
  )

  const emailId = queried.ids[0]

  section("Email/get")
  const full = await rpc([
    ["Email/get", { accountId, ids: [emailId], fetchTextBodyValues: true, properties: null }, "g1"],
  ])
  const message = responseFor(full, "g1")?.[1]?.list?.[0]
  check("a full email loads", Boolean(message), full)
  check("with a blobId", Boolean(message?.blobId))
  check("with a threadId", Boolean(message?.threadId))
  check("with mailboxIds", Boolean(message?.mailboxIds?.[inbox.id]))
  check("with structured from", Array.isArray(message?.from) && Boolean(message.from[0]?.email))
  check("with a text body part", Array.isArray(message?.textBody) && message.textBody.length >= 1)
  check(
    "and its value when asked",
    String((Object.values(message?.bodyValues ?? {})[0] as any)?.value ?? "").includes("Body of"),
    message?.bodyValues,
  )

  const missing = await rpc([
    ["Email/get", { accountId, ids: ["00000000-0000-0000-0000-000000000000"] }, "g2"],
  ])
  check(
    "a missing id is reported as notFound",
    responseFor(missing, "g2")?.[1]?.notFound?.length === 1,
  )

  section("Email/set")
  const flag = await rpc([
    ["Email/set", { accountId, update: { [emailId]: { "keywords/$seen": true } } }, "s0"],
    ["Email/get", { accountId, ids: [emailId], properties: ["keywords"] }, "s1"],
  ])
  check(
    "a keyword patch applies",
    responseFor(flag, "s1")?.[1]?.list?.[0]?.keywords?.$seen === true,
    flag,
  )

  const wholeKeywords = await rpc([
    ["Email/set", { accountId, update: { [emailId]: { keywords: { $flagged: true } } } }, "s2"],
    ["Email/get", { accountId, ids: [emailId], properties: ["keywords"] }, "s3"],
  ])
  const keywords = responseFor(wholeKeywords, "s3")?.[1]?.list?.[0]?.keywords
  check(
    "the whole-object form replaces the set",
    keywords?.$flagged === true && !keywords?.$seen,
    keywords,
  )

  const moved = await rpc([
    [
      "Email/set",
      { accountId, update: { [emailId]: { mailboxIds: { [createdId]: true } } } },
      "s4",
    ],
    ["Email/query", { accountId, filter: { inMailbox: createdId } }, "s5"],
  ])
  check(
    "a mailboxIds change moves the message",
    responseFor(moved, "s5")?.[1]?.ids?.length === 1,
    moved,
  )

  section("filters")
  const unread = await rpc([
    ["Email/query", { accountId, filter: { inMailbox: inbox.id, notKeyword: "$seen" } }, "f0"],
  ])
  check("notKeyword filters", responseFor(unread, "f0")?.[1]?.ids?.length === 2, unread)

  const textSearch = await rpc([["Email/query", { accountId, filter: { text: "Second" } }, "f1"]])
  check("a text filter searches", responseFor(textSearch, "f1")?.[1]?.ids?.length === 1, textSearch)

  const fromSearch = await rpc([
    ["Email/query", { accountId, filter: { from: "sender@far" } }, "f2"],
  ])
  check("a from filter searches", responseFor(fromSearch, "f2")?.[1]?.total >= 3, fromSearch)

  section("Thread and Identity")
  const thread = await rpc([
    ["Email/get", { accountId, ids: [emailId], properties: ["threadId"] }, "t0"],
    [
      "Thread/get",
      { accountId, "#ids": { resultOf: "t0", name: "Email/get", path: "/list/*/threadId" } },
      "t1",
    ],
  ])
  check(
    "threads resolve through a back-reference",
    responseFor(thread, "t1")?.[1]?.list?.length === 1,
    thread,
  )

  const identity = await rpc([["Identity/get", { accountId, ids: null }, "i0"]])
  check(
    "an identity is offered for the mailbox",
    responseFor(identity, "i0")?.[1]?.list?.[0]?.email === email,
    identity,
  )

  section("EmailSubmission")
  const draftBody = [
    `From: ${email}`,
    "To: someone@far.invalid",
    `Subject: Sent over JMAP ${suffix}`,
    `Message-ID: <jmapsend-${suffix}@${domainName}>`,
    "Date: Mon, 10 Aug 2026 12:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Sent through EmailSubmission/set.",
    "",
  ].join("\r\n")

  const upload = await fetch(`${BASE}/jmap/upload/${accountId}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "message/rfc822" },
    body: draftBody,
  })
  const uploaded = await upload.json()
  check("a blob can be uploaded", upload.status === 201 && Boolean(uploaded.blobId), uploaded)

  const submission = await rpc([
    [
      "EmailSubmission/set",
      {
        accountId,
        create: {
          send: {
            emailId: uploaded.blobId,
            envelope: {
              mailFrom: { email },
              rcptTo: [{ email: "someone@far.invalid" }],
            },
          },
        },
      },
      "e0",
    ],
  ])
  const submitted = responseFor(submission, "e0")?.[1]
  check("a message can be submitted", Boolean(submitted?.created?.send), submission)

  const queued = await db().one<{ count: string }>({
    text: "SELECT count(*)::text AS count FROM deliveries WHERE rcpt_to = 'someone@far.invalid'",
    values: [],
  })
  check("and is queued for delivery", Number(queued?.count ?? 0) >= 1, queued)

  section("blob download")
  const download = await fetch(`${BASE}/jmap/download/${accountId}/${emailId}/message.eml`, {
    headers: { authorization: auth },
  })
  const downloaded = await download.text()
  check(
    "a message downloads",
    download.status === 200 && downloaded.includes("Subject:"),
    download.status,
  )
  check(
    "and is never served as a renderable type",
    download.headers.get("content-type") !== "text/html",
    download.headers.get("content-type"),
  )

  section("changes")
  const state = await rpc([["Mailbox/get", { accountId, ids: [] }, "c9"]])
  const currentState = responseFor(state, "c9")?.[1]?.state
  check("a state string is returned", Boolean(currentState), currentState)

  const changes = await rpc([["Email/changes", { accountId, sinceState: "0" }, "ch0"]])
  check(
    "changes since zero lists everything",
    responseFor(changes, "ch0")?.[1]?.created?.length >= 3,
    responseFor(changes, "ch0")?.[1],
  )

  const noChanges = await rpc([["Email/changes", { accountId, sinceState: currentState }, "ch1"]])
  check(
    "changes since now lists nothing",
    responseFor(noChanges, "ch1")?.[1]?.created?.length === 0,
    responseFor(noChanges, "ch1")?.[1],
  )

  section("isolation")
  const otherSuffix = Math.random().toString(36).slice(2, 6)
  const { address: other } = await createAddress({
    domainId: domain.id,
    localPart: `other-${otherSuffix}`,
    type: "standard",
    password,
  })
  const foreignFolder = await db().one<{ id: string }>({
    text: "SELECT id FROM folders WHERE address_id = $1 LIMIT 1",
    values: [other.id],
  })
  const foreign = await rpc([
    ["Email/query", { accountId, filter: { inMailbox: foreignFolder!.id } }, "x0"],
  ])
  check(
    "another mailbox's folder yields nothing",
    responseFor(foreign, "x0")?.[1]?.ids?.length === 0,
    foreign,
  )

  const badAuth = await fetch(`${BASE}/.well-known/jmap`, {
    headers: { authorization: `Basic ${Buffer.from(`${email}:wrong`).toString("base64")}` },
  })
  check("a wrong password is refused", badAuth.status === 401, badAuth.status)

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
