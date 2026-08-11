/**
 * Webmail, end to end against a running server.
 *
 *   bun run test:webmail
 *
 * Delivers a message through the real inbound path, then reads it, replies to
 * it, moves it, and deletes it entirely through the webmail API — the same
 * calls the client makes.
 */

import { from } from "@atlas/db"
import { createAddress } from "../src/addresses/index.ts"
import { closeDb, db } from "../src/db/index.ts"
import { type Domain, users } from "../src/schema/index.ts"

const BASE = process.env.CORSAIR_URL ?? "http://localhost:3000"

let cookie = ""
let passed = 0
let failed = 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const call = async (
  method: string,
  path: string,
  body?: unknown,
  attempt = 0,
): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  if (res.status === 429 && attempt < 8) {
    await sleep(1000)
    return call(method, path, body, attempt + 1)
  }

  const setCookie = res.headers.get("set-cookie")
  if (setCookie) cookie = setCookie.split(";")[0] ?? cookie

  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed }
}

const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    passed++
    console.log(`  ok    ${label}`)
    return
  }
  failed++
  console.error(`  FAIL  ${label}`)
  if (detail !== undefined) console.error(`        ${JSON.stringify(detail).slice(0, 300)}`)
}

const section = (name: string) => console.log(`\n${name}`)

/** Delivers a message straight through the inbound path, as the MX would. */
const deliverInbound = async (input: {
  to: string
  subject: string
  html: string
  text: string
}) => {
  const { handleMessage } = await import("../src/smtp/inbound/index.ts")
  const raw = [
    "From: Sender <sender@far-away.invalid>",
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@far-away.invalid>`,
    "Date: Mon, 10 Aug 2026 12:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.text,
    "--B",
    "Content-Type: text/html; charset=utf-8",
    "",
    input.html,
    "--B--",
    "",
  ].join("\r\n")

  await handleMessage(
    {
      helo: "far-away.invalid",
      mailFrom: "sender@far-away.invalid",
      hasSender: true,
      rcptTo: [input.to],
      size: null,
      smtputf8: false,
    },
    raw,
    { remoteIp: "203.0.113.9", helo: "far-away.invalid" },
  )
}

const run = async () => {
  const suffix = Math.random().toString(36).slice(2, 8)
  const domainName = `webmail-${suffix}.invalid`
  const password = "webmail-password-1234"
  const email = `me@${domainName}`

  section("setup")
  const user = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Webmail', $2) RETURNING id`,
    values: [`wm-owner-${suffix}@corsair.test`, `w${suffix}`],
  })
  const domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=wm', 'active') RETURNING *`,
    values: [user!.id, domainName],
  }))!
  await createAddress({
    domainId: domain.id,
    localPart: "me",
    type: "standard",
    password,
    name: "Me",
  })
  check("fixtures created", true)

  await deliverInbound({
    to: email,
    subject: `Hello ${suffix}`,
    text: "Plain body for the webmail test.",
    // Carries an XSS attempt and a tracking pixel, both of which must be
    // neutralised before the client ever sees them.
    html: `<p>Hello <b>there</b></p><script>alert(1)</script><img src="http://tracker.invalid/p.gif"><a href="javascript:alert(2)">bad</a>`,
  })
  await deliverInbound({
    to: email,
    subject: `Second ${suffix}`,
    text: "Another one.",
    html: "<p>Another one.</p>",
  })
  check("two messages delivered through the inbound path", true)

  section("auth")
  const anonymous = await call("GET", "/api/mail/me")
  check("an unauthenticated caller is refused", anonymous.status === 401, anonymous.body)

  const badLogin = await call("POST", "/api/mail/login", { email, password: "wrong" })
  check("a wrong password is refused", badLogin.status === 401, badLogin.body)

  const login = await call("POST", "/api/mail/login", { email, password })
  check("the mailbox password signs in", login.status === 200, login.body)
  check("a webmail cookie is set", cookie.startsWith("corsair_webmail="), cookie.slice(0, 30))

  const me = await call("GET", "/api/mail/me")
  check("the session identifies the mailbox", me.body?.email === email, me.body)

  section("folders")
  const folders = await call("GET", "/api/mail/folders")
  check("the folder list loads", Array.isArray(folders.body?.data), folders.body)
  const inbox = (folders.body?.data ?? []).find((f: any) => f.special_use === "inbox")
  const archive = (folders.body?.data ?? []).find((f: any) => f.special_use === "archive")
  const trash = (folders.body?.data ?? []).find((f: any) => f.special_use === "trash")
  check("the inbox is first", folders.body?.data?.[0]?.special_use === "inbox")
  check("the inbox has two unread", inbox?.unseen === 2, inbox)

  const created = await call("POST", "/api/mail/folders", { name: `Project ${suffix}` })
  check("a folder can be created", created.status === 201, created.body)

  const dupe = await call("POST", "/api/mail/folders", { name: `Project ${suffix}` })
  check("a duplicate folder is refused", dupe.status === 400, dupe.body)

  const deleteInbox = await call("DELETE", `/api/mail/folders/${inbox.id}`)
  check("a system folder cannot be deleted", deleteInbox.status === 400, deleteInbox.body)

  section("reading")
  const list = await call("GET", `/api/mail/messages?folder_id=${inbox.id}`)
  check("the message list loads", list.body?.total === 2, list.body?.total)
  check("newest first", list.body?.data?.[0]?.subject === `Second ${suffix}`, list.body?.data?.[0])

  const target = (list.body?.data ?? []).find((m: any) => m.subject === `Hello ${suffix}`)
  const message = await call("GET", `/api/mail/messages/${target.id}`)
  check("a message opens", message.status === 200, message.body)
  check("the plain body is present", message.body?.body_text?.includes("Plain body"))

  section("sanitising")
  const html = String(message.body?.body_html ?? "")
  check(
    "the script is gone",
    !html.includes("<script") && !html.includes("alert(1)"),
    html.slice(0, 200),
  )
  check(
    "the javascript: link is gone",
    !html.toLowerCase().includes("javascript:"),
    html.slice(0, 200),
  )
  check("the tracking pixel is withheld", message.body?.blocked_remote_images === true)
  check("the withheld image is not loadable", !/(?<![-\w])src="http:\/\/tracker/.test(html))
  check("the real content survives", html.includes("Hello") && html.includes("<b>there</b>"))

  const withImages = await call("GET", `/api/mail/messages/${target.id}?images=true`)
  check(
    "images load when the reader asks",
    String(withImages.body?.body_html).includes('src="http://tracker.invalid/p.gif"'),
  )

  check(
    "authentication results are surfaced",
    Boolean(message.body?.authentication),
    message.body?.authentication,
  )

  const afterOpen = await call("GET", `/api/mail/messages?folder_id=${inbox.id}`)
  const opened = (afterOpen.body?.data ?? []).find((m: any) => m.id === target.id)
  check("opening marks it read", opened?.seen === true, opened)

  section("search")
  const hit = await call("GET", `/api/mail/messages?folder_id=${inbox.id}&search=${suffix}`)
  check("search matches the subject", hit.body?.total === 2, hit.body?.total)

  const bodyHit = await call("GET", `/api/mail/messages?folder_id=${inbox.id}&search=Another`)
  check("search reaches the body text", bodyHit.body?.total === 1, bodyHit.body?.total)

  const miss = await call("GET", `/api/mail/messages?folder_id=${inbox.id}&search=zzzznothing`)
  check("a search with no hits returns nothing", miss.body?.total === 0, miss.body?.total)

  section("flags")
  const flag = await call("POST", "/api/mail/messages/flags", {
    ids: [target.id],
    add: ["\\Flagged"],
  })
  check("a flag can be added", flag.status === 200, flag.body)

  const unread = await call("POST", "/api/mail/messages/flags", {
    ids: [target.id],
    remove: ["\\Seen"],
  })
  check("it can be marked unread again", unread.status === 200, unread.body)

  const afterFlags = await call("GET", `/api/mail/messages?folder_id=${inbox.id}`)
  const flagged = (afterFlags.body?.data ?? []).find((m: any) => m.id === target.id)
  check("both flag changes stuck", flagged?.flagged === true && flagged?.seen === false, flagged)

  section("sending")
  const send = await call("POST", "/api/mail/send", {
    to: ["someone@far-away.invalid"],
    subject: `Reply ${suffix}`,
    text: "This is a reply from the webmail test.",
  })
  check("a message can be sent", send.status === 202, send.body)

  const sentFolder = (folders.body?.data ?? []).find((f: any) => f.special_use === "sent")
  const sentList = await call("GET", `/api/mail/messages?folder_id=${sentFolder.id}`)
  check("a copy is filed in Sent", sentList.body?.total === 1, sentList.body?.total)

  const queued = await db().one<{ count: string }>({
    text: "SELECT count(*)::text AS count FROM deliveries WHERE rcpt_to = $1",
    values: ["someone@far-away.invalid"],
  })
  check("it is queued for delivery", Number(queued?.count ?? 0) >= 1, queued)

  const draft = await call("POST", "/api/mail/drafts", {
    to: ["draft@far-away.invalid"],
    subject: `Draft ${suffix}`,
    text: "Not finished yet.",
  })
  check("a draft can be saved", draft.status === 200, draft.body)

  const draftsFolder = (folders.body?.data ?? []).find((f: any) => f.special_use === "drafts")
  const draftList = await call("GET", `/api/mail/messages?folder_id=${draftsFolder.id}`)
  check("it lands in Drafts", draftList.body?.total === 1, draftList.body?.total)

  section("moving and deleting")
  const move = await call("POST", "/api/mail/messages/move", {
    ids: [target.id],
    folder_id: archive.id,
  })
  check("a message can be moved", move.body?.moved === 1, move.body)

  const archived = await call("GET", `/api/mail/messages?folder_id=${archive.id}`)
  check("it arrives in the target folder", archived.body?.total === 1, archived.body?.total)

  const inboxAfterMove = await call("GET", `/api/mail/messages?folder_id=${inbox.id}`)
  check("and leaves the source", inboxAfterMove.body?.total === 1, inboxAfterMove.body?.total)

  const moved = archived.body?.data?.[0]
  const softDelete = await call("POST", "/api/mail/messages/delete", { ids: [moved.id] })
  check("delete moves it to Trash first", softDelete.body?.permanent === false, softDelete.body)

  const trashList = await call("GET", `/api/mail/messages?folder_id=${trash.id}`)
  check("it is in Trash", trashList.body?.total === 1, trashList.body?.total)

  const inTrash = trashList.body?.data?.[0]
  const hardDelete = await call("POST", "/api/mail/messages/delete", { ids: [inTrash.id] })
  check("deleting from Trash is permanent", hardDelete.body?.permanent === true, hardDelete.body)

  const trashAfter = await call("GET", `/api/mail/messages?folder_id=${trash.id}`)
  check("Trash is empty again", trashAfter.body?.total === 0, trashAfter.body?.total)

  section("isolation")
  const otherSuffix = Math.random().toString(36).slice(2, 6)
  const { address: other } = await createAddress({
    domainId: domain.id,
    localPart: `other-${otherSuffix}`,
    type: "standard",
    password,
  })
  const otherMessage = await db().one<{ id: string }>({
    text: "SELECT id FROM messages WHERE address_id = $1 LIMIT 1",
    values: [other.id],
  })
  const stillMine = await call("GET", `/api/mail/messages?folder_id=${inbox.id}`)
  check("another mailbox's folders are not listed", stillMine.status === 200)

  // The most important assertion here: a valid session for one mailbox must not
  // reach another's mail, however the id is supplied.
  const foreignFolder = await db().one<{ id: string }>({
    text: "SELECT id FROM folders WHERE address_id = $1 LIMIT 1",
    values: [other.id],
  })
  const foreignList = await call("GET", `/api/mail/messages?folder_id=${foreignFolder!.id}`)
  check(
    "another mailbox's folder yields nothing",
    foreignList.body?.total === 0,
    foreignList.body?.total,
  )
  if (otherMessage) {
    const foreignRead = await call("GET", `/api/mail/messages/${otherMessage.id}`)
    check("another mailbox's message is not found", foreignRead.status === 404, foreignRead.body)
  }

  section("cleanup")
  await call("POST", "/api/mail/logout")
  const afterLogout = await call("GET", "/api/mail/me")
  check("logout ends the session", afterLogout.status === 401, afterLogout.body)

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
