import { from } from "@atlas/db"
import { folderBySpecialUse, ownerOfDomain } from "../../addresses/index.ts"
import { authenticateAddress, type MailIdentity } from "../../auth/index.ts"
import { config } from "../../config/index.ts"
import { db } from "../../db/index.ts"
import { sign } from "../../dkim/index.ts"
import { activeDkimKey } from "../../domains/index.ts"
import { queueId, rfcMessageId } from "../../ids/index.ts"
import * as mime from "../../mime/index.ts"
import { enqueue } from "../../outbound/index.ts"
import { withinDailyLimit } from "../../plans/index.ts"
import { type Address, addresses, type Domain, domains, mailLog } from "../../schema/index.ts"
import { deliver } from "../../store/index.ts"
import type { Envelope, Identity, Reply } from "../session/index.ts"

/**
 * Message submission (RFC 6409) — the authenticated path a customer's mail
 * client uses on 587 or 465.
 *
 * The rules here are the inverse of the MX path: the sender is known and must
 * be proven to belong to the caller, while the recipient can be anywhere. Every
 * relaying vulnerability in a mail server is a failure of exactly that first
 * check, which is why it is one function with no branches that let an
 * unauthenticated caller through.
 */

const identities = new Map<string, MailIdentity>()

export const authenticate = async (
  username: string,
  password: string,
): Promise<Identity | null> => {
  const identity = await authenticateAddress(username, password)
  if (!identity) return null
  identities.set(identity.address.id, identity)
  return { username: identity.email, id: identity.address.id }
}

const identityOf = (token: Identity | null): MailIdentity | null =>
  token ? (identities.get(token.id) ?? null) : null

/**
 * Which addresses a caller may put in MAIL FROM.
 *
 * Their own address always. Anything else on a domain the same account owns,
 * because a customer with `me@wess.io` legitimately sends as `billing@wess.io`
 * without wanting a second password. Nothing outside that: an authenticated
 * customer must not be able to send as another customer's domain.
 */
const mayUseSender = async (identity: MailIdentity, address: string): Promise<boolean> => {
  const wanted = address.toLowerCase()
  if (wanted === identity.email.toLowerCase()) return true

  const at = wanted.lastIndexOf("@")
  if (at <= 0) return false
  const domainName = wanted.slice(at + 1)

  const owner = await ownerOfDomain(identity.domain.id)
  if (!owner) return false

  const domain = await db().one<Domain>(
    from(domains).where((q) => [q("name").equals(domainName), q("user_id").equals(owner)]),
  )
  if (!domain) return false

  const local = wanted.slice(0, at)
  const row = await db().one<Address>(
    from(addresses).where((q) => [q("domain_id").equals(domain.id), q("local_part").equals(local)]),
  )
  return Boolean(row)
}

export const validateSender = async (
  address: string,
  token: Identity | null,
): Promise<Reply | null> => {
  const identity = identityOf(token)
  if (!identity) {
    return {
      code: 530,
      enhanced: "5.7.0",
      message: "Authentication required.",
    }
  }
  if (!address) {
    return { code: 550, enhanced: "5.7.1", message: "A submitted message needs a sender." }
  }
  if (!(await mayUseSender(identity, address))) {
    return {
      code: 550,
      enhanced: "5.7.1",
      message: `You are not allowed to send as ${address}.`,
    }
  }

  const owner = await ownerOfDomain(identity.domain.id)
  if (owner) {
    const limit = await withinDailyLimit(owner, "outbound", identity.address.daily_out_limit)
    if (!limit.ok) {
      return {
        code: 451,
        enhanced: "4.7.1",
        message: `Daily sending limit of ${limit.limit} messages reached. Try again tomorrow.`,
      }
    }
  }

  if (identity.domain.status !== "active") {
    // Sending from a domain whose SPF and DKIM are not published yet gets the
    // message marked as spam at the far end and the IP's reputation damaged.
    // Refusing here is kinder than letting it happen.
    return {
      code: 550,
      enhanced: "5.7.1",
      message: `${identity.domain.name} is not verified yet. Finish DNS setup before sending.`,
    }
  }

  return null
}

export const validateRecipient = async (
  address: string,
  token: Identity | null,
): Promise<Reply | null> => {
  if (!identityOf(token)) {
    return { code: 530, enhanced: "5.7.0", message: "Authentication required." }
  }
  if (!address.includes("@")) {
    return { code: 501, enhanced: "5.1.3", message: "Recipient address is not valid." }
  }
  return null
}

/**
 * Fills in the headers a mail client may have left off, without touching any it
 * set. Rewriting a client's own From is how a submission service breaks DKIM
 * for its users, so it is only added when absent.
 */
const completeHeaders = (raw: string, envelope: Envelope, identity: MailIdentity): string => {
  const parsed = mime.parseMessage(raw)
  const additions: string[] = []

  if (!mime.headerValue(parsed.headers, "date")) {
    additions.push(`Date: ${new Date().toUTCString()}`)
  }
  if (!mime.headerValue(parsed.headers, "message-id")) {
    additions.push(`Message-ID: ${rfcMessageId(identity.domain.name)}`)
  }
  if (!mime.headerValue(parsed.headers, "from")) {
    const display = identity.address.name
      ? `${mime.encodeWord(identity.address.name)} <${identity.email}>`
      : identity.email
    additions.push(`From: ${display}`)
  }
  if (!mime.headerValue(parsed.headers, "mime-version")) {
    additions.push("MIME-Version: 1.0")
  }

  const received = [
    `Received: from ${mime.stripControls(envelope.helo)} (authenticated as ${mime.stripControls(identity.email)})`,
    `\tby ${config.hostname} with ESMTPSA id ${queueId()};`,
    `\t${new Date().toUTCString()}`,
  ].join("\r\n")

  return `${received}\r\n${additions.length ? `${additions.join("\r\n")}\r\n` : ""}${raw}`
}

export const handleMessage = async (
  envelope: Envelope,
  raw: string,
  token: Identity | null,
): Promise<Reply> => {
  const identity = identityOf(token)
  if (!identity) return { code: 530, enhanced: "5.7.0", message: "Authentication required." }

  const normalized = mime.normalizeEol(raw)
  const complete = completeHeaders(normalized, envelope, identity)

  // Signed after the headers are complete and before anything is stored, so the
  // copy in Sent is byte-identical to what the recipient receives.
  const key = await activeDkimKey(identity.domain.id)
  const signed = key
    ? sign({
        raw: complete,
        domain: identity.domain.name,
        selector: key.selector,
        privateKey: key.private_key,
      })
    : complete

  await enqueue({
    raw: signed,
    mailFrom: envelope.mailFrom,
    recipients: envelope.rcptTo,
    addressId: identity.address.id,
    domainId: identity.domain.id,
  })

  // A copy in Sent, so the message appears in every client rather than only the
  // one that sent it. Clients that also APPEND their own copy will produce a
  // duplicate; that is preferable to a customer's phone showing no sent mail.
  const sent = await folderBySpecialUse(identity.address.id, "sent")
  if (sent) {
    await deliver({
      addressId: identity.address.id,
      folderId: sent.id,
      raw: signed,
      flags: ["\\Seen"],
    }).catch((e: unknown) => console.error("[corsair] could not file a copy in Sent:", e))
  }

  const parsed = mime.parseMessage(signed)
  const owner = await ownerOfDomain(identity.domain.id)
  for (const recipient of envelope.rcptTo) {
    await db()
      .execute(
        from(mailLog).insert({
          user_id: owner,
          domain_id: identity.domain.id,
          address_id: identity.address.id,
          direction: "outbound",
          status: "accepted",
          mail_from: envelope.mailFrom,
          rcpt_to: recipient,
          subject: mime.decodeWords(mime.headerValue(parsed.headers, "subject") ?? ""),
          message_id: mime.headerValue(parsed.headers, "message-id"),
          size: signed.length,
          dkim: key ? "signed" : "unsigned",
          code: 250,
        }),
      )
      .catch((e: unknown) => console.error("[corsair] mail_log insert failed:", e))
  }

  return { code: 250, enhanced: "2.0.0", message: "Message queued for delivery." }
}

/** Drops the cached identity when a session ends. */
export const forget = (token: Identity | null): void => {
  if (token) identities.delete(token.id)
}
