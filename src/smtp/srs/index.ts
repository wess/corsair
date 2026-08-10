import { createHmac } from "node:crypto"
import { config } from "../../config/index.ts"

/**
 * Sender Rewriting Scheme (SRS).
 *
 * When this server forwards mail for an alias, it becomes the sender as far as
 * the next hop is concerned — but the envelope sender still names the original
 * domain, whose SPF record does not list us. The next hop sees a forgery and
 * rejects it. Forwarding without SRS is the single most common reason an alias
 * "randomly stops working" on a mail host.
 *
 * The fix is to rewrite the envelope sender into our own domain, carrying the
 * original inside it, so that bounces can still be routed home. The HMAC is not
 * optional: without it the rewritten address is an open relay for anyone who
 * can guess the format.
 */

const SEPARATOR = "="
const HASH_LENGTH = 4
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** Days since the epoch, mod the two-character wrap, as the timestamp field. */
const timestamp = (at = Date.now()): string => {
  const days = Math.floor(at / 86_400_000) % 1024
  return `${BASE32[Math.floor(days / 32)]}${BASE32[days % 32]}`
}

const timestampAge = (stamp: string): number => {
  // The stamp is base32 in upper case by construction, but an MTA that
  // lower-cases the local part in transit would otherwise make every forwarded
  // bounce look like it came from a wrapped counter, i.e. expired.
  const upper = stamp.toUpperCase()
  const hi = BASE32.indexOf(upper[0] ?? "")
  const lo = BASE32.indexOf(upper[1] ?? "")
  if (hi === -1 || lo === -1) return Number.POSITIVE_INFINITY
  const encoded = hi * 32 + lo
  const today = Math.floor(Date.now() / 86_400_000) % 1024
  // The counter wraps, so a stamp "ahead" of today is really from the previous
  // cycle.
  return (today - encoded + 1024) % 1024
}

const sign = (payload: string): string =>
  createHmac("sha256", config.jwtSecret)
    .update(payload.toLowerCase())
    .digest("base64")
    .replace(/[^A-Za-z0-9]/g, "")
    .slice(0, HASH_LENGTH)

/**
 * `me@sender.com` forwarded via `wess.io` becomes
 * `SRS0=hash=stamp=sender.com=me@wess.io`.
 */
export const rewrite = (mailFrom: string, forwardingDomain: string): string => {
  if (!mailFrom) return ""

  const at = mailFrom.lastIndexOf("@")
  if (at <= 0) return mailFrom

  const localPart = mailFrom.slice(0, at)
  const domain = mailFrom.slice(at + 1)

  // Already rewritten by somebody else: swap our domain in and keep their
  // payload rather than nesting, which is what SRS1 exists to avoid.
  if (/^SRS[01]=/i.test(localPart)) {
    return `${localPart}@${forwardingDomain}`
  }

  const stamp = timestamp()
  const payload = `${stamp}${SEPARATOR}${domain}${SEPARATOR}${localPart}`
  return `SRS0${SEPARATOR}${sign(payload)}${SEPARATOR}${payload}@${forwardingDomain}`
}

export type Reversal =
  | { ok: true; address: string }
  | { ok: false; reason: "not_srs" | "bad_signature" | "expired" | "malformed" }

const MAX_AGE_DAYS = 21

/** Turns a rewritten address back into the original, or says why it will not. */
export const reverse = (address: string): Reversal => {
  const at = address.lastIndexOf("@")
  if (at <= 0) return { ok: false, reason: "malformed" }

  const localPart = address.slice(0, at)
  const parts = localPart.split(SEPARATOR)
  if (parts.length < 5 || parts[0]?.toUpperCase() !== "SRS0") {
    return { ok: false, reason: "not_srs" }
  }

  const [, hash = "", stamp = "", domain = "", ...rest] = parts
  const original = rest.join(SEPARATOR)
  if (!domain || !original) return { ok: false, reason: "malformed" }

  const payload = `${stamp}${SEPARATOR}${domain}${SEPARATOR}${original}`
  // Compared case-insensitively: some MTAs lower-case the local part in transit,
  // and losing every bounce to that is not worth the strictness.
  if (sign(payload).toLowerCase() !== hash.toLowerCase()) {
    return { ok: false, reason: "bad_signature" }
  }
  if (timestampAge(stamp) > MAX_AGE_DAYS) return { ok: false, reason: "expired" }

  return { ok: true, address: `${original}@${domain}` }
}

export const isRewritten = (address: string): boolean => /^SRS[01]=/i.test(address)
