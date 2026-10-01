import { from } from "@atlas/db"
import { folderBySpecialUse, ownerOfDomain } from "../addresses/index.ts"
import { db } from "../db/index.ts"
import { sign } from "../dkim/index.ts"
import { activeDkimKey } from "../domains/index.ts"
import { invalidParameter } from "../errors/index.ts"
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

  // Bcc recipients are in the envelope but never in the headers — that is the
  // entire point of Bcc, and a header would leak them to every other recipient.
  const recipients = [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])]
  await enqueue({
    raw: signed,
    mailFrom: email,
    recipients,
    addressId: address.id,
    domainId: domain.id,
  })

  const sent = await folderBySpecialUse(address.id, "sent")
  if (sent) {
    await deliver({
      addressId: address.id,
      folderId: sent.id,
      raw: signed,
      flags: ["\\Seen"],
    }).catch((e: unknown) => console.error("[corsair] could not file a copy in Sent:", e))
  }

  for (const recipient of recipients) {
    await db()
      .execute(
        from(mailLog).insert({
          user_id: owner,
          domain_id: domain.id,
          address_id: address.id,
          direction: "outbound",
          status: "accepted",
          mail_from: email,
          rcpt_to: recipient,
          subject: input.subject,
          message_id: messageId,
          size: signed.length,
          dkim: key ? "signed" : "unsigned",
          code: 250,
        }),
      )
      .catch(() => {})
  }

  return { queued: recipients.length, messageId }
}
