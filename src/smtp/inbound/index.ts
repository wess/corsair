import { reverse as reverseDns } from "node:dns/promises"
import { from } from "@atlas/db"
import {
  folderBySpecialUse,
  inboxOf,
  ownerOfDomain,
  type Route,
  resolveRecipient,
} from "../../addresses/index.ts"
import { config } from "../../config/index.ts"
import { db } from "../../db/index.ts"
import { aligned, fromDomainOf, verifySignature } from "../../dkim/index.ts"
import { activeDkimKey } from "../../domains/index.ts"
import { emit } from "../../events/index.ts"
import { queueId, uidValidity } from "../../ids/index.ts"
import * as mime from "../../mime/index.ts"
import { enqueue } from "../../outbound/index.ts"
import { assertStorageAvailable, withinDailyLimit } from "../../plans/index.ts"
import { type Filter, type Folder, filters, folders, mailLog } from "../../schema/index.ts"
import * as sieve from "../../sieve/index.ts"
import { checkSpf, lookupDmarc, spfAligned } from "../../spf/index.ts"
import { deliver } from "../../store/index.ts"
import { sendBounce } from "../bounce/index.ts"
import type { Envelope, Reply } from "../session/index.ts"
import { isJunk, type SpamVerdict, score } from "../spam/index.ts"
import { rewrite } from "../srs/index.ts"

/**
 * Everything that happens to a message arriving on port 25.
 *
 * The order is deliberate: authenticate the sender's *identity* first (SPF,
 * DKIM, DMARC), stamp the result into the message so a client can see it, score
 * it, and only then route it. Scoring before routing means one verdict is
 * computed for the message rather than one per recipient.
 */

export type InboundContext = {
  remoteIp: string
  helo: string
}

// ------------------------------------------------------------ recipients --

export const validateRecipient = async (
  address: string,
  _identity: unknown,
  _envelope: Envelope,
): Promise<Reply | null> => {
  const route = await resolveRecipient(address)

  if (route.kind === "unknown") {
    // The domain distinction matters to the sender: "we do not host this
    // domain" is a relay refusal, "no such user" is a delivery failure.
    return route.domain
      ? { code: 550, enhanced: "5.1.1", message: `No such user here: ${address}` }
      : { code: 550, enhanced: "5.7.1", message: "Relay access denied." }
  }

  if (route.kind === "mailbox") {
    const userId = await ownerOfDomain(route.domain.id)
    if (userId) {
      const limit = await withinDailyLimit(userId, "inbound", route.address.daily_in_limit)
      if (!limit.ok) {
        // 4xx, not 5xx: the recipient is over their daily allowance today, and
        // the sender should try again tomorrow rather than give up.
        return {
          code: 452,
          enhanced: "4.2.2",
          message: "Recipient has reached their message limit for today.",
        }
      }
    }
  }

  return null
}

// -------------------------------------------------------- authentication --

type AuthResults = {
  spf: string
  dkim: string
  dmarc: string
  dkimDomain: string | null
  reverseDns: string | null
}

const authenticate = async (
  raw: string,
  parsed: mime.ParsedMessage,
  envelope: Envelope,
  ctx: InboundContext,
): Promise<AuthResults> => {
  const [spf, dkim, ptr] = await Promise.all([
    checkSpf({ ip: ctx.remoteIp, mailFrom: envelope.mailFrom, helo: ctx.helo }),
    verifySignature(raw, parsed),
    reverseDns(ctx.remoteIp).then(
      (names) => names[0] ?? null,
      () => null,
    ),
  ])

  const fromDomain = fromDomainOf(parsed)
  let dmarc = "none"

  if (fromDomain) {
    const policy = await lookupDmarc(fromDomain)
    if (policy) {
      // DMARC passes if *either* SPF or DKIM both passes and aligns with the
      // From domain. One is enough by design — that is what makes forwarding
      // survivable, since forwarding breaks SPF but preserves DKIM.
      const spfOk = spf.result === "pass" && spfAligned(fromDomain, spf.domain, policy.aspf)
      const dkimOk =
        dkim.result === "pass" && dkim.domain
          ? aligned(fromDomain, dkim.domain, policy.adkim)
          : false
      dmarc = spfOk || dkimOk ? "pass" : "fail"
    }
  }

  return {
    spf: spf.result,
    dkim: dkim.result,
    dmarc,
    dkimDomain: dkim.domain,
    reverseDns: ptr,
  }
}

const authenticationResults = (results: AuthResults, envelope: Envelope): string => {
  const parts = [
    `spf=${results.spf} smtp.mailfrom=${envelope.mailFrom || "<>"}`,
    results.dkimDomain
      ? `dkim=${results.dkim} header.d=${results.dkimDomain}`
      : `dkim=${results.dkim}`,
    `dmarc=${results.dmarc}`,
  ]
  return `Authentication-Results: ${config.hostname}; ${parts.join("; ")}`
}

const receivedHeader = (ctx: InboundContext, recipient: string): string => {
  const ptr = ctx.helo
  return [
    `Received: from ${mime.stripControls(ptr)} ([${ctx.remoteIp}])`,
    `\tby ${config.hostname} with ESMTP id ${queueId()}`,
    `\tfor <${mime.stripControls(recipient)}>;`,
    `\t${new Date().toUTCString()}`,
  ].join("\r\n")
}

// -------------------------------------------------------------- filtering --

const filterFor = async (filterId: string | null): Promise<Filter | null> =>
  filterId ? db().one<Filter>(from(filters).where((q) => q("id").equals(filterId))) : null

const folderNamed = async (
  addressId: string,
  name: string,
  create: boolean,
): Promise<Folder | null> => {
  const existing = await db().one<Folder>(
    from(folders).where((q) => [q("address_id").equals(addressId), q("name").equals(name)]),
  )
  if (existing || !create) return existing
  return db().one<Folder>(
    from(folders)
      .insert({ address_id: addressId, name, uid_validity: uidValidity() })
      .returning(
        "id",
        "address_id",
        "name",
        "special_use",
        "uid_validity",
        "uid_next",
        "highest_modseq",
        "subscribed",
        "created_at",
        "updated_at",
      ),
  )
}

// --------------------------------------------------------------- deliver --

type DeliveryOutcome = { code: number; status: string; detail: string }

const deliverToMailbox = async (
  route: Extract<Route, { kind: "mailbox" }>,
  raw: string,
  envelope: Envelope,
  ctx: InboundContext,
  results: AuthResults,
  verdict: SpamVerdict,
): Promise<DeliveryOutcome> => {
  const userId = await ownerOfDomain(route.domain.id)
  const stamped = `${receivedHeader(ctx, `${route.address.local_part}@${route.domain.name}`)}\r\n${authenticationResults(results, envelope)}\r\n${raw}`

  if (userId) {
    try {
      await assertStorageAvailable(userId, stamped.length)
    } catch {
      return {
        code: 452,
        status: "rejected",
        detail: "Recipient mailbox is over its storage quota.",
      }
    }
  }

  // A filter is the customer's own script and runs before anything is written,
  // so a `discard` never costs a write and a `reject` never leaves a copy.
  let decision: sieve.SieveResult = {
    fileInto: [],
    keep: true,
    discard: false,
    redirect: [],
    reject: null,
    flags: [],
    createFolders: false,
  }

  const filter = await filterFor(route.address.filter_id)
  if (filter && !filter.compile_error) {
    try {
      decision = sieve.run(filter.script, {
        message: mime.parseMessage(mime.normalizeEol(stamped)),
        size: stamped.length,
        envelopeFrom: envelope.mailFrom,
        envelopeTo: `${route.address.local_part}@${route.domain.name}`,
      })
    } catch (e) {
      // A script that throws at delivery time must not lose the message. It is
      // treated as absent, and the error is recorded for the panel to show.
      console.error("[corsair] sieve failed:", (e as Error).message)
      await db()
        .execute(
          from(filters)
            .where((q) => q("id").equals(filter.id))
            .update({ compile_error: (e as Error).message.slice(0, 500) }),
        )
        .catch(() => {})
    }
  }

  if (decision.reject) {
    return { code: 550, status: "rejected", detail: decision.reject }
  }

  for (const target of decision.redirect) {
    await enqueue({
      raw: stamped,
      mailFrom: rewrite(envelope.mailFrom, route.domain.name),
      recipients: [target],
      domainId: route.domain.id,
      addressId: route.address.id,
    })
  }

  if (decision.discard && !decision.fileInto.length && !decision.keep) {
    return { code: 250, status: "accepted", detail: "Discarded by filter." }
  }

  const targets: Folder[] = []
  for (const name of decision.fileInto) {
    const folder = await folderNamed(route.address.id, name, decision.createFolders)
    if (folder) targets.push(folder)
  }

  if (decision.keep || !targets.length) {
    // Junk goes to the Junk folder rather than the inbox — but only when the
    // script did not already choose a destination. A customer's explicit
    // fileinto outranks our spam heuristic.
    const junk = isJunk(verdict) && !targets.length
    const fallback = junk ? await folderBySpecialUse(route.address.id, "junk") : null
    targets.push(fallback ?? (await inboxOf(route.address.id)))
  }

  const flags = [...new Set(decision.flags)]
  const seen = new Set<string>()
  for (const folder of targets) {
    if (seen.has(folder.id)) continue
    seen.add(folder.id)
    await deliver({
      addressId: route.address.id,
      folderId: folder.id,
      raw: stamped,
      flags,
      spamScore: verdict.score,
    })
  }

  return { code: 250, status: "accepted", detail: `Delivered to ${targets.length} folder(s).` }
}

const deliverToForward = async (
  route: Extract<Route, { kind: "forward" }>,
  raw: string,
  envelope: Envelope,
  ctx: InboundContext,
  results: AuthResults,
): Promise<DeliveryOutcome> => {
  const recipient = `${route.address.local_part}@${route.domain.name}`
  const stamped = `${receivedHeader(ctx, recipient)}\r\n${authenticationResults(results, envelope)}\r\n${raw}`

  // The envelope sender is rewritten into the forwarding domain so the next hop
  // sees a sender whose SPF we actually satisfy. Without this, forwarding to
  // any large provider fails.
  await enqueue({
    raw: stamped,
    mailFrom: rewrite(envelope.mailFrom, route.domain.name),
    recipients: route.destinations,
    domainId: route.domain.id,
    addressId: route.address.id,
  })

  return {
    code: 250,
    status: "accepted",
    detail: `Forwarded to ${route.destinations.length} recipient(s).`,
  }
}

// ------------------------------------------------------------- entrypoint --

export const handleMessage = async (
  envelope: Envelope,
  raw: string,
  ctx: InboundContext,
): Promise<Reply> => {
  const normalized = mime.normalizeEol(raw)
  const parsed = mime.parseMessage(normalized)
  const results = await authenticate(normalized, parsed, envelope, ctx)

  const verdict = score(normalized, {
    spf: results.spf,
    dkim: results.dkim,
    dmarc: results.dmarc,
    helo: ctx.helo,
    remoteIp: ctx.remoteIp,
    mailFrom: envelope.mailFrom,
    reverseDns: results.reverseDns,
  })

  const subject = mime.decodeWords(mime.headerValue(parsed.headers, "subject") ?? "")
  const messageId = mime.headerValue(parsed.headers, "message-id")

  let accepted = 0
  let lastFailure: DeliveryOutcome | null = null

  for (const recipient of envelope.rcptTo) {
    const route = await resolveRecipient(recipient)
    let outcome: DeliveryOutcome

    if (route.kind === "mailbox") {
      outcome = await deliverToMailbox(route, normalized, envelope, ctx, results, verdict)
    } else if (route.kind === "forward") {
      outcome = await deliverToForward(route, normalized, envelope, ctx, results)
    } else {
      // The recipient existed at RCPT time and does not now. Rare, but a
      // deletion mid-transaction is exactly when it happens.
      outcome = { code: 550, status: "rejected", detail: "No such user here." }
    }

    const userId = route.kind === "unknown" ? null : await ownerOfDomain(route.domain.id)
    await db()
      .execute(
        from(mailLog).insert({
          user_id: userId,
          domain_id: route.kind === "unknown" ? null : route.domain.id,
          address_id: route.kind === "unknown" ? null : route.address.id,
          direction: "inbound",
          status: outcome.status,
          mail_from: envelope.mailFrom,
          rcpt_to: recipient,
          subject,
          message_id: messageId,
          size: normalized.length,
          remote_ip: ctx.remoteIp,
          remote_host: results.reverseDns,
          spf: results.spf,
          dkim: results.dkim,
          dmarc: results.dmarc,
          spam_score: verdict.score,
          code: outcome.code,
          detail: outcome.detail,
        }),
      )
      .catch((e: unknown) => console.error("[corsair] mail_log insert failed:", e))

    // Fire-and-forget: a customer's endpoint must never hold up an SMTP
    // transaction, and a failure to notify must never fail a delivery.
    void emit({
      userId,
      domainId: route.kind === "unknown" ? null : route.domain.id,
      type:
        outcome.code >= 400
          ? "message.rejected"
          : isJunk(verdict)
            ? "message.spam"
            : "message.received",
      data: {
        recipient,
        sender: envelope.mailFrom,
        subject,
        message_id: messageId,
        size: normalized.length,
        spam_score: verdict.score,
        authentication: { spf: results.spf, dkim: results.dkim, dmarc: results.dmarc },
        remote_ip: ctx.remoteIp,
        ...(outcome.code >= 400 ? { reason: outcome.detail, code: outcome.code } : {}),
      },
    })

    if (outcome.code < 400) accepted++
    else {
      lastFailure = outcome
      // A per-recipient failure inside a multi-recipient transaction cannot be
      // reported in the single reply to DATA, so it becomes a bounce.
      if (envelope.rcptTo.length > 1) {
        await sendBounce({
          recipient,
          returnPath: envelope.mailFrom,
          code: outcome.code,
          status: outcome.code >= 500 ? "5.1.1" : "4.2.2",
          reason: outcome.detail,
          originalHeaders: normalized.slice(0, parsed.bodyStart),
          originalMessageId: messageId,
        }).catch(() => {})
      }
    }
  }

  if (accepted > 0) {
    return {
      code: 250,
      enhanced: "2.0.0",
      message: `Message accepted for ${accepted} recipient(s).`,
    }
  }
  return {
    code: lastFailure?.code ?? 550,
    enhanced: (lastFailure?.code ?? 550) >= 500 ? "5.0.0" : "4.0.0",
    message: lastFailure?.detail ?? "Message could not be delivered.",
  }
}

/** MX never relays, so the sender is only checked for a syntactically sane address. */
export const validateSender = async (address: string): Promise<Reply | null> => {
  if (!address) return null // the null sender is legal and means "this is a bounce"
  if (!address.includes("@") || address.startsWith("@")) {
    return { code: 501, enhanced: "5.1.7", message: "Sender address is not valid." }
  }
  return null
}

/** Exposed for the submission path, which signs on the way out. */
export const signingKeyFor = activeDkimKey
