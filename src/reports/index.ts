import * as mime from "../mime/index.ts"

/**
 * Delivery status notifications and feedback reports, for mail sent over the
 * sending API.
 *
 * An API send leaves with a VERP return path — `bounces+<email id>@<domain>` —
 * so a failure the receiving server discovers *after* it said 250 comes back
 * here rather than vanishing. That is most real bounces: "user unknown" and
 * "mailbox full" are routinely decided after the transaction, not during it.
 *
 * Two formats matter:
 *
 *   RFC 3464  multipart/report; report-type=delivery-status  — bounces
 *   RFC 5965  multipart/report; report-type=feedback-report  — spam complaints
 */

const CRLF = "\r\n"

export type DsnAction = "failed" | "delayed" | "delivered" | "relayed" | "expanded"

export type DeliveryStatus = {
  recipient: string | null
  action: DsnAction
  /** RFC 3463 `class.subject.detail`, e.g. `5.1.1`. */
  status: string | null
  /** 2 success, 4 transient, 5 permanent. Null when nothing says which. */
  statusClass: 2 | 4 | 5 | null
  diagnosticCode: string | null
  remoteMta: string | null
}

export type BounceReport = {
  kind: "dsn"
  reportingMta: string | null
  recipients: DeliveryStatus[]
  originalMessageId: string | null
}

export type ComplaintReport = {
  kind: "arf"
  /** abuse | fraud | virus | not-spam | other */
  feedbackType: string
  originalMessageId: string | null
  originalRecipient: string | null
  reportedBy: string | null
}

export type Report = BounceReport | ComplaintReport

// ---------------------------------------------------------------- fields --

/**
 * Header-shaped fields, as `message/delivery-status` and
 * `message/feedback-report` carry them. The first occurrence of a name wins;
 * folded continuation lines are joined.
 */
const fieldsOf = (block: string): Map<string, string> => {
  const out = new Map<string, string>()
  let current: string | null = null
  for (const line of block.split(CRLF)) {
    if (/^[ \t]/.test(line)) {
      if (current && out.has(current)) out.set(current, `${out.get(current)} ${line.trim()}`)
      continue
    }
    const colon = line.indexOf(":")
    if (colon <= 0) {
      current = null
      continue
    }
    const name = line.slice(0, colon).trim().toLowerCase()
    current = out.has(name) ? null : name
    if (current) out.set(name, line.slice(colon + 1).trim())
  }
  return out
}

// `rfc822; user@example.com` — the address type is not part of the value.
const stripType = (value: string | undefined): string | null => {
  if (!value) return null
  const semi = value.indexOf(";")
  const raw = (semi === -1 ? value : value.slice(semi + 1)).trim()
  return raw.replace(/^<|>$/g, "") || null
}

const classOf = (status: string | null): 2 | 4 | 5 | null => {
  const first = status?.trim()[0]
  return first === "2" ? 2 : first === "4" ? 4 : first === "5" ? 5 : null
}

/**
 * Some MTAs omit Status and put the SMTP reply in Diagnostic-Code. A 5xx there
 * is just as authoritative, and reading a hard bounce as unknown would leave a
 * dead address on the list.
 */
const classFromDiagnostic = (diagnostic: string | null): 4 | 5 | null => {
  const match = diagnostic?.match(/\b([45])\d{2}\b/)
  if (!match) return null
  return match[1] === "5" ? 5 : 4
}

const partsOf = (message: mime.ParsedMessage): mime.Part[] => {
  const out: mime.Part[] = []
  mime.walk(message.root, (p) => {
    out.push(p)
  })
  return out
}

const find = (parts: mime.Part[], type: string, subtype: string): mime.Part | undefined =>
  parts.find((p) => p.type === type && p.subtype === subtype)

/** The returned original arrives either whole or as its headers alone. */
const originalMessageId = (raw: string, parts: mime.Part[]): string | null => {
  const whole = find(parts, "message", "rfc822")
  if (whole?.child) return mime.headerValue(whole.child.headers, "message-id")?.trim() ?? null

  const headersOnly = find(parts, "text", "rfc822-headers")
  if (!headersOnly) return null
  return fieldsOf(raw.slice(headersOnly.bodyStart, headersOnly.end)).get("message-id") ?? null
}

// ----------------------------------------------------------------- parse --

const parseDsn = (raw: string, parts: mime.Part[]): BounceReport | null => {
  const status = find(parts, "message", "delivery-status")
  if (!status) return null

  // One per-message group, then one group per recipient, separated by blank
  // lines.
  const groups = mime
    .partText(raw, status)
    .replace(/\r\n|\r|\n/g, CRLF)
    .split(`${CRLF}${CRLF}`)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(fieldsOf)
  if (!groups.length) return null

  const recipients: DeliveryStatus[] = groups.slice(1).map((group) => {
    const code = group.get("status")?.trim() || null
    // `smtp; 550 5.1.1 ...` — the diagnostic type is not part of what was said.
    const diagnostic =
      group
        .get("diagnostic-code")
        ?.replace(/^\s*[A-Za-z-]+\s*;\s*/, "")
        .replace(/\s+/g, " ")
        .trim() || null
    return {
      recipient:
        stripType(group.get("original-recipient")) ?? stripType(group.get("final-recipient")),
      action: (group.get("action")?.trim().toLowerCase() ?? "failed") as DsnAction,
      status: code,
      statusClass: classOf(code) ?? classFromDiagnostic(diagnostic),
      diagnosticCode: diagnostic,
      remoteMta: stripType(group.get("remote-mta")),
    }
  })

  return {
    kind: "dsn",
    reportingMta: stripType(groups[0]!.get("reporting-mta")),
    recipients,
    originalMessageId: originalMessageId(raw, parts),
  }
}

const parseArf = (raw: string, parts: mime.Part[]): ComplaintReport | null => {
  const report = find(parts, "message", "feedback-report")
  if (!report) return null

  const fields = fieldsOf(
    mime
      .partText(raw, report)
      .replace(/\r\n|\r|\n/g, CRLF)
      .trim(),
  )
  return {
    kind: "arf",
    feedbackType: (fields.get("feedback-type") ?? "other").trim().toLowerCase(),
    originalMessageId: fields.get("message-id") ?? originalMessageId(raw, parts),
    originalRecipient: stripType(fields.get("original-rcpt-to")),
    reportedBy: fields.get("reporting-mta") ?? fields.get("user-agent") ?? null,
  }
}

/**
 * Returns null when the message is not a report at all. Arriving at a bounce
 * address is itself evidence something went wrong, so the caller still records
 * that — this only decides whether we can say what.
 */
export const parseReport = (input: string): Report | null => {
  const raw = mime.normalizeEol(input)
  const message = mime.parseMessage(raw)
  const root = message.root
  if (root.type !== "multipart" || root.subtype !== "report") return null

  const parts = partsOf(message)
  const reportType = (root.params["report-type"] ?? "").toLowerCase()
  if (reportType === "feedback-report") return parseArf(raw, parts)
  if (reportType === "delivery-status" || reportType === "") return parseDsn(raw, parts)
  return null
}

// ------------------------------------------------------------- verdicts --

export type Verdict = {
  severity: "hard" | "soft" | "complaint" | "delivered" | "unknown"
  recipient: string | null
  status: string | null
  detail: string | null
}

/**
 * Reduces a report to what the sending side acts on. A DSN may name several
 * recipients, and each becomes its own verdict: one address failing says
 * nothing about the others.
 */
export const verdicts = (report: Report): Verdict[] => {
  if (report.kind === "arf") {
    return [
      {
        // not-spam is a retraction. Treating it as a complaint would suppress an
        // address for asking to *keep* receiving mail.
        severity: report.feedbackType === "not-spam" ? "unknown" : "complaint",
        recipient: report.originalRecipient,
        status: null,
        detail: `feedback-type ${report.feedbackType}`,
      },
    ]
  }

  return report.recipients.map((entry) => {
    const detail = entry.diagnosticCode ?? entry.status ?? null
    const base = { recipient: entry.recipient, status: entry.status, detail }
    if (entry.action === "delivered" || entry.action === "relayed") {
      return { ...base, severity: "delivered" as const }
    }
    if (entry.action === "delayed" || entry.statusClass === 4) {
      return { ...base, severity: "soft" as const }
    }
    if (entry.statusClass === 5) return { ...base, severity: "hard" as const }
    return { ...base, severity: "unknown" as const }
  })
}

/**
 * Whether a permanent failure means the address itself is gone, which is the
 * only kind of failure that earns a suppression.
 *
 * A 5xx is permanent for *that message*, not necessarily for the recipient:
 * `5.7.1` is a policy refusal of the content, `5.2.2` is a full mailbox, `5.3.4`
 * is a message too large. Suppressing on any of those stops mail to a person who
 * is still there. So only the address-status codes count — `5.1.x` (bad
 * mailbox, bad domain, bad syntax) and `5.2.1` (mailbox disabled) — plus, when
 * a server sends no enhanced code at all, a 550/551/553 whose text plainly says
 * the user does not exist.
 */
export const isRecipientGone = (input: {
  status?: string | null
  detail?: string | null
  code?: number | null
}): boolean => {
  // Whitespace-delimited, so the tail of an address like 10.5.1.12 in a
  // server's reply is not read as a status code.
  const enhanced =
    input.status?.trim() || input.detail?.match(/(?:^|\s)([245]\.\d{1,3}\.\d{1,3})(?=\s|$)/)?.[1]
  if (enhanced) return /^5\.1\.\d+$/.test(enhanced) || enhanced === "5.2.1"

  const code = input.code ?? Number(input.detail?.match(/\b(5\d{2})\b/)?.[1] ?? 0)
  if (![550, 551, 553].includes(code)) return false
  return /no such (user|mailbox|recipient)|(user|mailbox|recipient|address)\b[^.]{0,40}\b(unknown|not found|does not exist|doesn't exist|invalid|disabled)/i.test(
    input.detail ?? "",
  )
}

// ------------------------------------------------------------- addresses --

const BOUNCE_LOCAL = /^bounces\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

/** The envelope sender an API send leaves with. */
export const returnPathFor = (emailId: string, domain: string): string =>
  `bounces+${emailId}@${domain}`

/**
 * Splits `bounces+<email id>@<domain>`. Null for anything else, including a
 * `bounces+` address whose tag is not an id — those belong to whoever set up a
 * mailbox called `bounces`, and are routed like any other mail.
 */
export const parseBounceAddress = (address: string): { emailId: string; domain: string } | null => {
  const at = address.lastIndexOf("@")
  if (at <= 0) return null
  const match = address.slice(0, at).match(BOUNCE_LOCAL)
  if (!match) return null
  return { emailId: match[1]!.toLowerCase(), domain: address.slice(at + 1).toLowerCase() }
}
