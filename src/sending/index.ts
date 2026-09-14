import { randomUUID } from "node:crypto"
import { from } from "@atlas/db"
import type { Permission } from "../apikeys/index.ts"
import { config } from "../config/index.ts"
import { allColumns, db } from "../db/index.ts"
import { sign } from "../dkim/index.ts"
import { activeDkimKey } from "../domains/index.ts"
import {
  dailyQuotaExceeded,
  invalidAttachment,
  invalidFromAddress,
  invalidParameter,
  missingRequiredField,
  notFound,
  senderNotAllowed,
} from "../errors/index.ts"
import { type EventType, emit } from "../events/index.ts"
import { rfcMessageId } from "../ids/index.ts"
import * as mime from "../mime/index.ts"
import { enqueue, releaseInline } from "../outbound/index.ts"
import { withinDailyLimit } from "../plans/index.ts"
import {
  isRecipientGone,
  parseBounceAddress,
  parseReport,
  returnPathFor,
  verdicts,
} from "../reports/index.ts"
import { normalizeSchedule, parseScheduledAt } from "../scheduling/index.ts"
import {
  type Delivery,
  type Domain,
  type Email,
  emails,
  mailLog,
  type Tag,
} from "../schema/index.ts"
import { isSuppressed, normalizeRecipient, suppress } from "../suppressions/index.ts"

/**
 * The sending API: an application hands over a message as JSON and Corsair
 * delivers it as one of the account's domains.
 *
 * It is the submission path without a mailbox. The same queue delivers it, the
 * same DKIM key signs it, the same daily limit counts it. What differs is who
 * is proven to be sending — an API key belonging to the account that owns the
 * domain, rather than a mailbox credential on it — and what happens when it
 * fails: nobody is waiting for a bounce in an inbox, so the failure becomes an
 * event, and an address that is gone is suppressed so the application stops
 * mailing it.
 *
 * The request and response shapes are Resend's, so an application written
 * against Resend moves here by changing its base URL.
 */

export type Sender = {
  userId: string
  /** Null when the panel is reading with a session rather than a key. */
  keyId: string | null
  permission: Permission
  /** Set when the key may send from one domain only. */
  domainId: string | null
}

type Addressish = string | string[] | null | undefined

export type AttachmentInput = {
  /** Base64, a byte array, or a Node Buffer as `JSON.stringify` renders one. */
  content?: string | number[] | { type: "Buffer"; data: number[] } | null
  filename?: string | null
  path?: string | null
  content_type?: string | null
  content_id?: string | null
}

export type SendInput = {
  from?: string
  to?: Addressish
  cc?: Addressish
  bcc?: Addressish
  reply_to?: Addressish
  subject?: string
  html?: string | null
  text?: string | null
  headers?: Record<string, string>
  tags?: Tag[]
  scheduled_at?: string | null
  attachments?: AttachmentInput[]
  template?: unknown
  topic_id?: unknown
}

const MAX_RECIPIENTS = 50

// ASCII only. An internationalised local part needs SMTPUTF8 on every hop,
// which this path does not negotiate, and the DKIM signer works in octets.
const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/

const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,75}$/

/**
 * Headers this server writes. A caller setting them could contradict what the
 * DKIM signature vouches for, smuggle a Bcc into the visible headers, or break
 * the MIME tree the body depends on.
 */
const RESERVED_HEADERS = new Set([
  "authentication-results",
  "bcc",
  "cc",
  "content-disposition",
  "content-id",
  "content-transfer-encoding",
  "content-type",
  "date",
  "dkim-signature",
  "from",
  "message-id",
  "mime-version",
  "received",
  "reply-to",
  "return-path",
  "sender",
  "subject",
  "to",
])

const TAG = /^[A-Za-z0-9_-]{1,256}$/

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const CONTENT_TYPE = /^[A-Za-z0-9][\w.+-]*\/[A-Za-z0-9][\w.+-]*$/

const MIME_BY_EXT: Record<string, string> = {
  csv: "text/csv",
  gif: "image/gif",
  html: "text/html",
  ics: "text/calendar",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  pdf: "application/pdf",
  png: "image/png",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  zip: "application/zip",
}

// Refused outright. Receiving servers strip or reject these anyway, and an
// application that sends one learns it here rather than from a silent drop.
const BLOCKED_EXTENSIONS = new Set([
  "bat",
  "chm",
  "cmd",
  "com",
  "cpl",
  "dll",
  "exe",
  "hta",
  "jar",
  "js",
  "jse",
  "lnk",
  "msi",
  "msp",
  "pif",
  "ps1",
  "reg",
  "scr",
  "sct",
  "vbe",
  "vbs",
  "wsf",
  "wsh",
])

// -------------------------------------------------------------- validate --

const display = (address: mime.MailAddress): string =>
  address.name ? `${address.name} <${address.address}>` : address.address

const addressList = (value: Addressish, field: string): mime.MailAddress[] => {
  if (value === null || value === undefined) return []
  const out: mime.MailAddress[] = []
  for (const entry of Array.isArray(value) ? value : [value]) {
    const parsed = mime.parseAddressList(entry)
    if (!parsed.length) throw invalidParameter(`Invalid \`${field}\` address: ${entry}`)
    for (const address of parsed) {
      if (!ADDRESS.test(address.address)) {
        throw invalidParameter(`Invalid \`${field}\` address: ${address.address}`)
      }
      out.push(address)
    }
  }
  return out
}

type PreparedAttachment = {
  filename: string
  contentType: string
  content: Buffer
  contentId: string | null
}

const decodeAttachment = (input: AttachmentInput): PreparedAttachment => {
  // Fetching a caller-supplied URL from inside this network and mailing the
  // response back out is a full-read request forgery, not a blind one. Refused
  // rather than guarded: a hostname check does not stop a public name that
  // resolves to a private address.
  if (input.path) {
    throw invalidAttachment(
      "Attachments by `path` are not supported. Send the file's bytes as base64 `content`.",
    )
  }
  if (!input.filename) throw invalidAttachment("Each attachment needs a `filename`.")
  const name = input.filename

  let content: Buffer
  if (typeof input.content === "string") {
    const clean = input.content.replace(/\s+/g, "")
    // Buffer.from skips characters that are not base64 rather than failing,
    // which would send a quietly corrupted file.
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
      throw invalidAttachment(`\`${name}\` is not valid base64.`)
    }
    content = Buffer.from(clean, "base64")
  } else if (Array.isArray(input.content)) {
    content = Buffer.from(input.content)
  } else if (input.content && Array.isArray(input.content.data)) {
    content = Buffer.from(input.content.data)
  } else {
    throw invalidAttachment(`\`${name}\` has no \`content\`.`)
  }

  const ext = name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : ""
  if (BLOCKED_EXTENSIONS.has(ext)) {
    throw invalidAttachment(`Attachments with the \`.${ext}\` extension are not accepted.`)
  }

  const contentType = input.content_type?.trim() || MIME_BY_EXT[ext] || "application/octet-stream"
  if (!CONTENT_TYPE.test(contentType)) {
    throw invalidAttachment(`\`${contentType}\` is not a valid content type.`)
  }

  const contentId = input.content_id?.trim().replace(/^<|>$/g, "") || null
  if (contentId && !/^[^\s<>"]+$/.test(contentId)) {
    throw invalidAttachment(`\`${contentId}\` is not a valid content id.`)
  }

  return {
    // Quoted into a MIME parameter, so a quote or backslash would end it early.
    filename: mime.encodeWord(name.replace(/["\\]/g, "_")),
    contentType,
    content,
    contentId,
  }
}

/**
 * The domain a send leaves from.
 *
 * One answer for "not yours" and "not verified". Which domains other accounts
 * host on this server is not a caller's business, and a domain that has not
 * finished DNS setup must not send: its mail would fail SPF and DKIM at the far
 * end and spend the server's reputation doing it.
 */
const sendingDomain = async (address: string, sender: Sender): Promise<Domain> => {
  const host = address.slice(address.lastIndexOf("@") + 1).toLowerCase()
  const domain = await db().one<Domain>({
    text: "SELECT * FROM domains WHERE name = $1 AND user_id = $2",
    values: [host, sender.userId],
  })
  if (domain?.status !== "active") {
    throw senderNotAllowed(
      `The ${host} domain is not verified. Add it to this account and finish its DNS setup before sending from it.`,
    )
  }
  if (sender.domainId && sender.domainId !== domain.id) {
    throw senderNotAllowed(`This API key is restricted to a different domain than ${host}.`)
  }
  return domain
}

export type Prepared = {
  domain: Domain
  from: string
  /** The envelope: every to, cc, and bcc address, folded and deduplicated. */
  recipients: string[]
  to: string[]
  cc: string[]
  bcc: string[]
  replyTo: string[]
  subject: string
  html: string | null
  text: string | null
  tags: Tag[]
  scheduledAt: Date | null
  messageId: string
  raw: string
  signed: boolean
}

/**
 * Validates a send and builds the signed message, without queueing anything.
 * Separate from `createEmail` so a batch can validate every entry before it
 * commits to any of them.
 */
export const prepareSend = async (input: SendInput, sender: Sender): Promise<Prepared> => {
  if (input.template !== undefined && input.template !== null) {
    throw invalidParameter("Templates are not supported by this server. Send `html` or `text`.")
  }
  if (input.topic_id !== undefined && input.topic_id !== null) {
    throw invalidParameter("Topics are not supported by this server.")
  }

  if (!input.from) throw missingRequiredField("Missing `from` field.")
  const fromList = mime.parseAddressList(input.from)
  const fromAddress = fromList[0]
  if (fromList.length !== 1 || !fromAddress || !ADDRESS.test(fromAddress.address)) {
    throw invalidFromAddress(
      "Invalid `from` field. The email address needs to follow the `email@example.com` or `Name <email@example.com>` format.",
    )
  }

  const to = addressList(input.to, "to")
  if (!to.length) throw missingRequiredField("Missing `to` field.")
  const cc = addressList(input.cc, "cc")
  const bcc = addressList(input.bcc, "bcc")
  const replyTo = addressList(input.reply_to, "reply_to")

  const recipients = [...new Set([...to, ...cc, ...bcc].map((a) => normalizeRecipient(a.address)))]
  if (recipients.length > MAX_RECIPIENTS) {
    throw invalidParameter(
      `Too many recipients. One email can go to at most ${MAX_RECIPIENTS} addresses across \`to\`, \`cc\`, and \`bcc\`.`,
    )
  }

  if (typeof input.subject !== "string") throw missingRequiredField("Missing `subject` field.")
  const html = input.html || null
  const text = input.text || null
  if (!html && !text) throw missingRequiredField("Missing `html` or `text` field.")

  const tags = input.tags ?? []
  for (const tag of tags) {
    if (!TAG.test(tag.name) || !TAG.test(tag.value)) {
      throw invalidParameter(
        "Tag names and values may only contain ASCII letters, numbers, underscores, and dashes.",
      )
    }
  }

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (!HEADER_NAME.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
      throw invalidParameter(`\`${name}\` cannot be set as a custom header.`)
    }
    headers[name] = mime.encodeWord(String(value))
  }

  const attachments = (input.attachments ?? []).map(decodeAttachment)
  const scheduledAt = normalizeSchedule(parseScheduledAt(input.scheduled_at))

  // Last, because it is the only check that reads the database.
  const domain = await sendingDomain(fromAddress.address, sender)

  const messageId = rfcMessageId(domain.name)
  const built = mime.buildMessage({
    from: fromAddress,
    to,
    cc,
    replyTo,
    subject: input.subject,
    html: html ?? undefined,
    text: text ?? undefined,
    messageId,
    headers,
    attachments,
  })
  if (built.length > config.maxMessageBytes) {
    const mb = (n: number) => Math.ceil(n / 1_048_576)
    throw invalidParameter(
      `The message is ${mb(built.length)} MB, over this server's limit of ${mb(config.maxMessageBytes)} MB.`,
    )
  }

  const key = await activeDkimKey(domain.id)
  const raw = key
    ? sign({ raw: built, domain: domain.name, selector: key.selector, privateKey: key.private_key })
    : built

  return {
    domain,
    from: display(fromAddress),
    recipients,
    to: to.map(display),
    cc: cc.map(display),
    bcc: bcc.map(display),
    replyTo: replyTo.map(display),
    subject: input.subject,
    html,
    text,
    tags,
    scheduledAt,
    messageId,
    raw,
    signed: Boolean(key),
  }
}

// ---------------------------------------------------------------- events --

const LAST_EVENT: Partial<Record<EventType, string>> = {
  "email.scheduled": "scheduled",
  "email.sent": "sent",
  "email.delivered": "delivered",
  "email.delivery_delayed": "delivery_delayed",
  "email.bounced": "bounced",
  "email.complained": "complained",
  "email.failed": "failed",
  "email.suppressed": "suppressed",
}

/**
 * Moves an email's `last_event` and tells the account's hooks. The payload is
 * Resend's `data` object, plus `recipient`, because an email to several people
 * can be delivered to one and bounce for another.
 */
const record = async (
  email: Email,
  type: EventType,
  extra: Record<string, unknown> = {},
): Promise<void> => {
  const state = LAST_EVENT[type]
  if (state) {
    // A canceled send stays canceled whatever a straggling row reports.
    await db().execute({
      text: `UPDATE emails SET last_event = $2, updated_at = now()
              WHERE id = $1 AND last_event <> 'canceled'`,
      values: [email.id, state],
    })
  }
  await emit({
    userId: email.user_id,
    domainId: email.domain_id,
    type,
    data: {
      email_id: email.id,
      created_at: email.created_at.toISOString(),
      from: email.from_address,
      to: email.to_addresses,
      subject: email.subject,
      ...(email.tags.length ? { tags: email.tags } : {}),
      ...extra,
    },
  })
}

// ---------------------------------------------------------------- create --

export const createEmail = async (prepared: Prepared, sender: Sender): Promise<Email> => {
  const limit = await withinDailyLimit(sender.userId, "outbound")
  if (!limit.ok) throw dailyQuotaExceeded(limit.limit)

  const email = (await db().one<Email>(
    from(emails)
      .insert({
        id: randomUUID(),
        user_id: sender.userId,
        domain_id: prepared.domain.id,
        api_key_id: sender.keyId,
        message_id: prepared.messageId,
        from_address: prepared.from,
        to_addresses: prepared.to,
        cc_addresses: prepared.cc,
        bcc_addresses: prepared.bcc,
        reply_to: prepared.replyTo,
        subject: prepared.subject,
        html: prepared.html,
        text: prepared.text,
        tags: prepared.tags,
        last_event: prepared.scheduledAt ? "scheduled" : "sent",
        scheduled_at: prepared.scheduledAt,
        size: prepared.raw.length,
      })
      .returning(...allColumns(emails)),
  ))!

  const returnPath = returnPathFor(email.id, prepared.domain.name)
  try {
    await enqueue({
      raw: prepared.raw,
      mailFrom: returnPath,
      recipients: prepared.recipients,
      domainId: prepared.domain.id,
      messageId: prepared.messageId,
      emailId: email.id,
      runAt: prepared.scheduledAt,
    })
  } catch (e) {
    // An id handed back for a message that was never queued is worse than an
    // error: the application would wait forever for events that cannot come.
    await db().execute({ text: "DELETE FROM emails WHERE id = $1", values: [email.id] })
    throw e
  }

  for (const recipient of prepared.recipients) {
    await db()
      .execute(
        from(mailLog).insert({
          user_id: sender.userId,
          domain_id: prepared.domain.id,
          direction: "outbound",
          status: "accepted",
          mail_from: returnPath,
          rcpt_to: recipient,
          subject: prepared.subject,
          message_id: prepared.messageId,
          size: prepared.raw.length,
          dkim: prepared.signed ? "signed" : "unsigned",
          code: 250,
          detail: "Accepted over the sending API.",
        }),
      )
      .catch((e: unknown) => console.error("[corsair] mail_log insert failed:", e))
  }

  await record(email, prepared.scheduledAt ? "email.scheduled" : "email.sent")
  return email
}

// ----------------------------------------------------------------- queue --

const emailById = (id: string): Promise<Email | null> =>
  db().one<Email>(from(emails).where((q) => q("id").equals(id)))

/** Takes a claimed row out of the queue without attempting it. */
const settle = async (row: Delivery, status: string, reason: string): Promise<void> => {
  await db().execute({
    text: `UPDATE deliveries SET status = $2, last_error = $3, locked_at = NULL, locked_by = NULL,
                                 updated_at = now()
            WHERE id = $1`,
    values: [row.id, status, reason],
  })
  await releaseInline(row.storage_key)
}

/**
 * Runs before the queue attempts a row that belongs to an API send. False means
 * the row was settled here and must not be attempted.
 *
 * Suppression is checked now rather than when the email was accepted, so a send
 * scheduled for tomorrow still respects a bounce that arrives tonight.
 */
export const beforeAttempt = async (row: Delivery): Promise<boolean> => {
  if (!row.email_id) return true
  const email = await emailById(row.email_id)
  // Swept while still queued. The message was accepted, so it is delivered.
  if (!email) return true

  if (email.last_event === "canceled") {
    await settle(row, "cancelled", "Canceled before it was sent.")
    return false
  }

  if (await isSuppressed(email.user_id, row.rcpt_to)) {
    await settle(row, "suppressed", "The recipient is on this account's suppression list.")
    await record(email, "email.suppressed", { recipient: row.rcpt_to })
    return false
  }

  // A scheduled send is sent at its first attempt. Conditional, so an email to
  // several recipients reports it once.
  const started = await db().all<{ id: string }>({
    text: `UPDATE emails SET last_event = 'sent', updated_at = now()
            WHERE id = $1 AND last_event = 'scheduled' RETURNING id`,
    values: [email.id],
  })
  if (started.length) await record(email, "email.sent")
  return true
}

export const afterDelivered = async (
  row: Delivery,
  detail: { code: number; host: string | null },
): Promise<void> => {
  const email = row.email_id ? await emailById(row.email_id) : null
  if (email) await record(email, "email.delivered", { recipient: row.rcpt_to, ...detail })
}

export const afterDeferred = async (
  row: Delivery,
  detail: { code: number; reason: string; attempt: number },
): Promise<void> => {
  const email = row.email_id ? await emailById(row.email_id) : null
  if (email) await record(email, "email.delivery_delayed", { recipient: row.rcpt_to, ...detail })
}

/**
 * A row that will not be retried. There is no DSN to send: the return path is
 * our own bounce address, so the notification would only come straight back
 * here. The application hears through its events, and an address that is gone
 * is suppressed so it stops being mailed.
 */
export const afterFailed = async (
  row: Delivery,
  code: number,
  reason: string,
  opts: { local?: boolean } = {},
): Promise<void> => {
  const email = row.email_id ? await emailById(row.email_id) : null
  if (!email) return

  // Nothing the far end said: this server could not attempt it at all.
  if (opts.local) {
    await record(email, "email.failed", { recipient: row.rcpt_to, reason })
    return
  }

  const gone = isRecipientGone({ code, detail: reason })
  if (gone) {
    await suppress({
      userId: email.user_id,
      address: row.rcpt_to,
      reason: "bounce",
      detail: reason,
      emailId: email.id,
    })
  }
  await record(email, "email.bounced", {
    recipient: row.rcpt_to,
    bounce: {
      type: code >= 500 ? "Permanent" : "Transient",
      message: reason.slice(0, 500),
      code,
    },
    suppressed: gone,
  })
}

// --------------------------------------------------------------- reports --

/**
 * The email a `bounces+<id>@<domain>` recipient refers to, or null for any
 * other address. Checked before normal routing, so a customer's own catch-all
 * or `bounces@` mailbox never swallows a report meant for the queue.
 */
export const bounceTarget = async (address: string): Promise<Email | null> => {
  const parsed = parseBounceAddress(address)
  if (!parsed) return null
  return db().one<Email>({
    text: `SELECT e.* FROM emails e JOIN domains d ON d.id = e.domain_id
            WHERE e.id = $1 AND d.name = $2`,
    values: [parsed.emailId, parsed.domain],
  })
}

const recipientsOf = (email: Email): string[] =>
  [...email.to_addresses, ...email.cc_addresses, ...email.bcc_addresses].flatMap((entry) =>
    mime.parseAddressList(entry).map((a) => normalizeRecipient(a.address)),
  )

/** Applies a report that arrived at an email's bounce address. */
export const applyReport = async (
  email: Email,
  raw: string,
): Promise<{ applied: number; detail: string }> => {
  const report = parseReport(raw)
  // Auto-replies are addressed to the return path as well (RFC 3834), and a
  // vacation notice is not a delivery failure.
  if (!report) return { applied: 0, detail: "Not a delivery report; ignored." }

  const sentTo = recipientsOf(email)
  let applied = 0

  for (const verdict of verdicts(report)) {
    const recipient = verdict.recipient
      ? normalizeRecipient(verdict.recipient)
      : sentTo.length === 1
        ? sentTo[0]!
        : null

    // The return path is visible to everyone the email reached. Without this
    // check any one of them could send a forged report naming an arbitrary
    // address and have it suppressed on the sending account.
    if (!recipient || !sentTo.includes(recipient)) continue

    if (verdict.severity === "hard") {
      const gone = isRecipientGone({ status: verdict.status, detail: verdict.detail })
      if (gone) {
        await suppress({
          userId: email.user_id,
          address: recipient,
          reason: "bounce",
          detail: verdict.detail,
          emailId: email.id,
        })
      }
      await record(email, "email.bounced", {
        recipient,
        bounce: { type: "Permanent", message: verdict.detail, status: verdict.status },
        suppressed: gone,
      })
      applied++
    } else if (verdict.severity === "soft") {
      await record(email, "email.delivery_delayed", {
        recipient,
        reason: verdict.detail,
        status: verdict.status,
      })
      applied++
    } else if (verdict.severity === "complaint") {
      await suppress({
        userId: email.user_id,
        address: recipient,
        reason: "complaint",
        detail: verdict.detail,
        emailId: email.id,
      })
      await record(email, "email.complained", {
        recipient,
        complaint: { message: verdict.detail },
      })
      applied++
    }
  }

  const kind = report.kind === "arf" ? "Feedback" : "Delivery"
  return { applied, detail: `${kind} report; ${applied} verdict(s) applied.` }
}

// ------------------------------------------------------------ management --

export const findEmail = async (userId: string, id: string): Promise<Email> => {
  const row = await db().one<Email>(
    from(emails).where((q) => [q("id").equals(id), q("user_id").equals(userId)]),
  )
  if (!row) throw notFound("Email not found.")
  return row
}

/**
 * Cancels a scheduled send. The state change is conditional, so a send whose
 * first attempt started a moment ago is reported as no longer cancelable rather
 * than half-canceled.
 */
export const cancelEmail = async (email: Email): Promise<void> => {
  const changed = await db().all<{ id: string }>({
    text: `UPDATE emails SET last_event = 'canceled', updated_at = now()
            WHERE id = $1 AND last_event = 'scheduled' RETURNING id`,
    values: [email.id],
  })
  if (!changed.length) throw invalidParameter("Only scheduled emails can be canceled.")

  const rows = await db().all<{ storage_key: string | null }>({
    text: `UPDATE deliveries SET status = 'cancelled', updated_at = now()
            WHERE email_id = $1 AND status = 'queued' RETURNING storage_key`,
    values: [email.id],
  })
  // Every row of one email shares a single stored body.
  if (rows[0]) await releaseInline(rows[0].storage_key)
}

export const rescheduleEmail = async (email: Email, value: string): Promise<void> => {
  const at = normalizeSchedule(parseScheduledAt(value))
  if (!at) throw invalidParameter("`scheduled_at` must be in the future.")

  const changed = await db().all<{ id: string }>({
    text: `UPDATE emails SET scheduled_at = $2, updated_at = now()
            WHERE id = $1 AND last_event = 'scheduled' RETURNING id`,
    values: [email.id, at],
  })
  if (!changed.length) throw invalidParameter("Only scheduled emails can be rescheduled.")

  await db().execute({
    text: `UPDATE deliveries SET run_at = $2, updated_at = now()
            WHERE email_id = $1 AND status = 'queued'`,
    values: [email.id, at],
  })
}

/**
 * Newest first, with Resend's cursors: `after` pages toward older emails,
 * `before` toward newer.
 */
export const listEmails = async (
  userId: string,
  query: { limit?: string; after?: string; before?: string },
): Promise<{ data: Email[]; hasMore: boolean }> => {
  const limit = query.limit === undefined ? 20 : Number(query.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw invalidParameter("`limit` must be a whole number between 1 and 100.")
  }
  if (query.after && query.before) throw invalidParameter("Use `after` or `before`, not both.")

  const cursor = query.after ?? query.before ?? null
  if (cursor && !UUID.test(cursor)) throw invalidParameter("A cursor must be an email id.")

  const newer = Boolean(query.before)
  const values: unknown[] = [userId]
  let where = "user_id = $1"
  if (cursor) {
    values.push(cursor)
    // Compared inside SQL. A created_at round-tripped through a JS Date loses
    // its microseconds, which puts the cursor row inside its own page.
    where += ` AND (created_at, id) ${newer ? ">" : "<"}
               (SELECT created_at, id FROM emails WHERE id = $2 AND user_id = $1)`
  }
  values.push(limit + 1)

  const order = newer ? "ASC" : "DESC"
  const rows = await db().all<Email>({
    text: `SELECT * FROM emails WHERE ${where}
            ORDER BY created_at ${order}, id ${order} LIMIT $${values.length}`,
    values,
  })

  const page = rows.slice(0, limit)
  return { data: newer ? page.reverse() : page, hasMore: rows.length > limit }
}
