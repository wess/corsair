import { config } from "../../config/index.ts"
import { isCorrespondent } from "../../correspondents/index.ts"
import { db } from "../../db/index.ts"
import { groupsV6, isPublicAddress } from "../../safefetch/index.ts"
import { checkSpf } from "../../spf/index.ts"
import { ipv4Of } from "../dnsbl/index.ts"
import type { Reply } from "../session/index.ts"

/**
 * Greylisting: the first message on a (client network, sender, recipient)
 * triplet is deferred, and a retry after the delay is accepted. A real MTA
 * retries; most spam software does not.
 *
 * Off by default (`SPAM_GREYLIST`), because the cost lands on the product's own
 * users: a first message from someone new arrives minutes late, and a sign-in
 * code can expire on the way. The exemptions exist to keep that cost to mail
 * that has given no other evidence of being wanted.
 */

export type Triplet = { firstSeen: Date; lastSeen: Date; passedAt: Date | null }

export type Policy = {
  /** How long a first attempt waits before a retry is accepted. */
  delayMs: number
  /** How long after the first attempt a retry still counts. */
  retryMs: number
  /** How long a passed triplet, or a passed network, stays trusted. */
  whitelistMs: number
}

const DAY = 24 * 60 * 60 * 1000

export const policy = (): Policy => ({
  delayMs: config.spam.greylistDelay * 1000,
  retryMs: DAY,
  whitelistMs: 36 * DAY,
})

/**
 * One step of the state machine, pure so the tests can drive the clock.
 *
 * A retry that comes back after the window has closed starts over rather than
 * passing: it is as likely a new spam run on the same triplet as a slow MTA.
 */
export const step = (
  row: Triplet | null,
  now: Date,
  p: Policy,
): { verdict: "pass" | "defer"; row: Triplet } => {
  const fresh = {
    verdict: "defer" as const,
    row: { firstSeen: now, lastSeen: now, passedAt: null },
  }
  if (!row) return fresh

  if (row.passedAt) {
    if (now.getTime() - row.lastSeen.getTime() <= p.whitelistMs) {
      return { verdict: "pass", row: { ...row, lastSeen: now } }
    }
    return fresh
  }

  const age = now.getTime() - row.firstSeen.getTime()
  if (age < p.delayMs) return { verdict: "defer", row: { ...row, lastSeen: now } }
  if (age <= p.retryMs) return { verdict: "pass", row: { ...row, lastSeen: now, passedAt: now } }
  return fresh
}

/**
 * The network a client is greylisted as: its /24 or /64. Large senders retry
 * from a different machine in the same pool, and an exact-address key would
 * defer them on every retry until the window closed.
 */
export const clientNet = (ip: string): string | null => {
  const four = ipv4Of(ip)
  if (four) return `${four.split(".").slice(0, 3).join(".")}.0/24`
  const g = groupsV6(ip)
  if (!g) return null
  return `${g
    .slice(0, 4)
    .map((x) => x.toString(16))
    .join(":")}::/64`
}

export type GreylistInput = {
  remoteIp: string
  /** This server talking to itself; see `spfExempt` in `src/smtp/inbound`. */
  local: boolean
  authenticated: boolean
  helo: string
  mailFrom: string
  recipient: string
  /** The mailbox the recipient routes to, when it is one. */
  addressId: string | null
}

/**
 * Why a message skips greylisting without touching the database, or null.
 *
 * The null sender is exempt because it is a bounce, and a bounce delayed is a
 * bounce some senders give up on: RFC 5321 makes `MAIL FROM:<>` mandatory on
 * every delivery status notification, and Corsair's own queue sends them.
 */
export const exemption = (input: GreylistInput): string | null => {
  if (input.authenticated) return "authenticated"
  if (input.local) return "local"
  if (!input.mailFrom) return "null sender"
  if (!isPublicAddress(input.remoteIp)) return "private client"
  return null
}

const GREYLISTED: Reply = {
  code: 451,
  enhanced: "4.7.1",
  message: "Greylisted: this server defers first contact. Please try again in a few minutes.",
}

export type Deps = {
  spf?: (input: { ip: string; mailFrom: string; helo: string }) => Promise<string>
  now?: Date
  policy?: Policy
}

// RCPT is answered once per recipient, and every recipient of one transaction
// would otherwise evaluate the same SPF record again.
const spfMemo = new Map<string, { at: number; result: Promise<string> }>()

const spfOnce = (input: { ip: string; mailFrom: string; helo: string }): Promise<string> => {
  const key = `${input.ip}|${input.mailFrom}|${input.helo}`
  const hit = spfMemo.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.result
  if (spfMemo.size > 1000) spfMemo.clear()
  const result = checkSpf(input).then(
    (o) => o.result,
    () => "temperror",
  )
  spfMemo.set(key, { at: Date.now(), result })
  return result
}

/**
 * Null to accept the recipient, or the 451 that defers it.
 *
 * Checked in order of cost: the free exemptions, then whether this network has
 * already proven it retries, then — with SPF passing for the sender — whether
 * the recipient has written to them or their domain has passed before, and only
 * then the triplet itself. SPF is required for the last two because both are
 * claims the envelope makes about itself.
 */
export const checkGreylist = async (
  input: GreylistInput,
  deps: Deps = {},
): Promise<Reply | null> => {
  if (exemption(input)) return null
  const net = clientNet(input.remoteIp)
  if (!net) return null

  const p = deps.policy ?? policy()
  const now = deps.now ?? new Date()
  const since = new Date(now.getTime() - p.whitelistMs)
  const sender = input.mailFrom.toLowerCase()
  const domain = sender.split("@")[1] ?? ""
  const recipient = input.recipient.toLowerCase()

  const provenNet = await db().one({
    text: `SELECT 1 AS found FROM greylist
            WHERE client_net = $1 AND passed_at IS NOT NULL AND last_seen > $2 LIMIT 1`,
    values: [net, since],
  })
  if (provenNet) return null

  const spf = await (deps.spf ?? spfOnce)({
    ip: input.remoteIp,
    mailFrom: input.mailFrom,
    helo: input.helo,
  })
  if (spf === "pass") {
    if (input.addressId && (await isCorrespondent(input.addressId, sender))) return null
    const provenDomain = await db().one({
      text: `SELECT 1 AS found FROM greylist
              WHERE sender_domain = $1 AND passed_at IS NOT NULL AND last_seen > $2 LIMIT 1`,
      values: [domain, since],
    })
    if (provenDomain) return null
  }

  const existing = await db().one<{
    first_seen: Date
    last_seen: Date
    passed_at: Date | null
  }>({
    text: `SELECT first_seen, last_seen, passed_at FROM greylist
            WHERE client_net = $1 AND sender = $2 AND recipient = $3`,
    values: [net, sender, recipient],
  })
  const next = step(
    existing
      ? {
          firstSeen: new Date(existing.first_seen),
          lastSeen: new Date(existing.last_seen),
          passedAt: existing.passed_at ? new Date(existing.passed_at) : null,
        }
      : null,
    now,
    p,
  )

  // Two concurrent first attempts both insert; the loser's update is the same
  // state, so the race costs nothing worse than one extra deferral.
  await db().execute({
    text: `INSERT INTO greylist (client_net, sender, sender_domain, recipient, first_seen, last_seen, passed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (client_net, sender, recipient) DO UPDATE SET
             first_seen = EXCLUDED.first_seen,
             last_seen = EXCLUDED.last_seen,
             passed_at = EXCLUDED.passed_at`,
    values: [
      net,
      sender,
      domain,
      recipient,
      next.row.firstSeen,
      next.row.lastSeen,
      next.row.passedAt,
    ],
  })

  return next.verdict === "pass" ? null : GREYLISTED
}
