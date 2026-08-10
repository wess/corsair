import { config } from "../../config/index.ts"
import { rfcMessageId } from "../../ids/index.ts"
import * as mime from "../../mime/index.ts"
import { enqueue } from "../../outbound/index.ts"

/**
 * Generates a delivery status notification (RFC 3464).
 *
 * The multipart/report structure matters: a plain-text "it didn't work" is
 * unreadable to the automated bounce processing on the other side, and the
 * sender of a failed message is very often a machine. The human-readable part
 * exists for the case where it is not.
 */

const CRLF = "\r\n"

export type BounceInput = {
  /** The address the failed message was addressed to. */
  recipient: string
  /** The envelope sender of the failed message — where the bounce goes. */
  returnPath: string
  code: number
  status: string
  reason: string
  /** Headers of the original message, for the third report part. */
  originalHeaders?: string
  originalMessageId?: string | null
}

const boundary = () => `=_corsair_dsn_${Math.random().toString(36).slice(2)}`

export const buildBounce = (input: BounceInput): string => {
  const sep = boundary()
  const postmaster = `postmaster@${config.hostname}`
  const now = new Date().toUTCString()

  const human = [
    `This is the mail delivery system at ${config.hostname}.`,
    "",
    "Your message could not be delivered to one or more recipients.",
    "",
    `  <${input.recipient}>`,
    `  ${input.code} ${input.status} ${input.reason}`,
    "",
    "No further attempt will be made to deliver this message.",
  ].join(CRLF)

  const report = [
    `Reporting-MTA: dns; ${config.hostname}`,
    `Arrival-Date: ${now}`,
    "",
    `Final-Recipient: rfc822; ${input.recipient}`,
    "Action: failed",
    `Status: ${input.status}`,
    `Diagnostic-Code: smtp; ${input.code} ${input.reason}`,
  ].join(CRLF)

  const lines = [
    `Date: ${now}`,
    `From: Mail Delivery System <${postmaster}>`,
    `To: <${input.returnPath}>`,
    "Subject: Undelivered Mail Returned to Sender",
    `Message-ID: ${rfcMessageId(config.hostname)}`,
    // A bounce must have a null return path, or two servers that both bounce
    // will bounce each other's bounces until one of them gives up.
    "Auto-Submitted: auto-replied",
    "MIME-Version: 1.0",
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${sep}"`,
    "",
    `--${sep}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    human,
    "",
    `--${sep}`,
    "Content-Type: message/delivery-status",
    "",
    report,
    "",
  ]

  if (input.originalHeaders) {
    lines.push(
      `--${sep}`,
      "Content-Type: text/rfc822-headers",
      "",
      mime.normalizeEol(input.originalHeaders),
      "",
    )
  }

  lines.push(`--${sep}--`, "")
  return lines.join(CRLF)
}

/**
 * Queues a bounce, unless the message that failed was itself a bounce.
 *
 * An empty return path means "do not bounce this" — that is the entire purpose
 * of the null sender, and honouring it is what stops a mail loop between two
 * misconfigured servers from running until somebody notices.
 */
export const sendBounce = async (input: BounceInput): Promise<boolean> => {
  if (!input.returnPath || input.returnPath === "<>") return false

  const raw = buildBounce(input)
  await enqueue({
    raw,
    mailFrom: "",
    recipients: [input.returnPath],
    messageId: input.originalMessageId ?? null,
  })
  return true
}

/** The headers of a raw message, for inclusion in a report. */
export const headersOf = (raw: string): string => {
  const parsed = mime.parseMessage(mime.normalizeEol(raw))
  return raw.slice(0, parsed.bodyStart)
}
