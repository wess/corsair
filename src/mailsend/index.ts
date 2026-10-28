import { from } from "@wess/atlas/db/query"
import { folderBySpecialUse, ownerOfDomain } from "../addresses/index.ts"
import { AGENT_DAILY_SENDS, reserveSends } from "../agents/index.ts"
import { recordCorrespondents } from "../correspondents/index.ts"
import { db } from "../db/index.ts"
import { sign } from "../dkim/index.ts"
import { activeDkimKey } from "../domains/index.ts"
import { dailyQuotaExceeded, forbidden, invalidParameter } from "../errors/index.ts"
import { emit } from "../events/index.ts"
import { rfcMessageId } from "../ids/index.ts"
import * as mime from "../mime/index.ts"
import { enqueue } from "../outbound/index.ts"
import { withinDailyLimit } from "../plans/index.ts"
import { type Address, type Domain, mailLog } from "../schema/index.ts"
import { deliver } from "../store/index.ts"

export type MailboxSend = {
  address: Address
  domain: Domain
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  inReplyTo?: string | null
  references?: string[]
}

/**
 * Sends one message as a mailbox: build, DKIM-sign, queue, file a copy in Sent,
 * and journal each recipient.
 *
 * Shared by the webmail and by agent mailboxes, which is why it lives here and
 * not in either route. Two copies of "sign before storing, keep Bcc out of the
 * headers" would drift, and the one that lost the Bcc rule would leak it.
 */
export const sendFromMailbox = async (
  input: MailboxSend,
): Promise<{ queued: number; messageId: string }> => {
  const { address, domain } = input
  const email = `${address.local_part}@${domain.name}`

  if (domain.status !== "active") {
    throw invalidParameter(`${domain.name} is not verified yet. Finish DNS setup before sending.`)
  }

  const owner = await ownerOfDomain(domain.id)
  if (owner) {
    const limit = await withinDailyLimit(owner, "outbound", address.daily_out_limit)
    if (!limit.ok) {
      throw invalidParameter(
        `Daily sending limit of ${limit.limit} messages reached. Try again tomorrow.`,
      )
    }
  }

  // Bcc recipients are in the envelope but never in the headers — that is the
  // entire point of Bcc, and a header would leak them to every other recipient.
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]

  // After every check that can refuse, before anything is queued: an agent's
  // allowance is spent only on mail that is actually about to go.
  const reserved = await reserveSends(address, recipients.length)
  if (!reserved.ok) {
    throw reserved.reason === "disabled"
      ? forbidden(
          "This agent can only read. Turn on sending for it in the control panel, or with PATCH /api/agents/:id.",
        )
      : dailyQuotaExceeded(AGENT_DAILY_SENDS)
  }

  const messageId = rfcMessageId(domain.name)
  const raw = mime.buildMessage({
    from: { name: address.name, address: email },
    to: input.to.map((a) => ({ name: null, address: a })),
    cc: input.cc?.map((a) => ({ name: null, address: a })),
    subject: input.subject,
    text: input.text,
    messageId,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references,
  })

  // Signed before anything is stored, so the copy in Sent is byte-identical to
  // what the recipient receives.
  const key = await activeDkimKey(domain.id)
  const signed = key
    ? sign({ raw, domain: domain.name, selector: key.selector, privateKey: key.private_key })
    : raw

  await enqueue({
    raw: signed,
    mailFrom: email,
    recipients,
    addressId: address.id,
    domainId: domain.id,
  })
  await recordCorrespondents(address, recipients)

  const sent = await folderBySpecialUse(address.id, "sent")
  if (sent) {
    await deliver({
      addressId: address.id,
      folderId: sent.id,
      raw: signed,
      flags: ["\\Seen"],
    }).catch((e: unknown) => console.error("[corsair] could not file a copy in Sent:", e))
  }

  await recordSent({
    owner,
    domainId: domain.id,
    addressId: address.id,
    mailFrom: email,
    recipients,
    subject: input.subject,
    messageId,
    size: signed.length,
    signed: Boolean(key),
  })

  return { queued: recipients.length, messageId }
}

export type SentRecord = {
  owner: string | null
  domainId: string
  addressId: string
  mailFrom: string
  recipients: string[]
  subject: string
  messageId: string | null
  size: number
  signed: boolean
}

/**
 * Journals a message a person (or an agent) just queued, one row per recipient,
 * and emits `message.sent` for each.
 *
 * Every send path calls this after `enqueue`: SMTP submission, `sendFromMailbox`,
 * and JMAP `EmailSubmission`. The rows are not only the log the panel shows —
 * `withinDailyLimit` counts them, so a path that skipped this one sent mail
 * nothing ever counted against the daily limit. JMAP did, until this existed.
 */
export const recordSent = async (sent: SentRecord): Promise<void> => {
  for (const recipient of sent.recipients) {
    await db()
      .execute(
        from(mailLog).insert({
          user_id: sent.owner,
          domain_id: sent.domainId,
          address_id: sent.addressId,
          direction: "outbound",
          status: "accepted",
          mail_from: sent.mailFrom,
          rcpt_to: recipient,
          subject: sent.subject,
          message_id: sent.messageId,
          size: sent.size,
          dkim: sent.signed ? "signed" : "unsigned",
          code: 250,
        }),
      )
      .catch((e: unknown) => console.error("[corsair] mail_log insert failed:", e))

    void emit({
      userId: sent.owner,
      domainId: sent.domainId,
      type: "message.sent",
      data: {
        recipient,
        sender: sent.mailFrom,
        subject: sent.subject,
        message_id: sent.messageId,
        size: sent.size,
      },
    })
  }
}
