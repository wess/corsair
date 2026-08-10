import { randomBytes, randomUUID } from "node:crypto"

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

export const uuid = (): string => randomUUID()

const base62 = (byteLength: number): string => {
  const bytes = randomBytes(byteLength)
  let out = ""
  for (const b of bytes) out += BASE62[b % 62]
  return out
}

export const secret = (bytes = 32): string => randomBytes(bytes).toString("base64url")

// Published as a TXT record on the customer's domain to prove they control it.
export const verificationToken = (): string => `mail-host-verify=${randomBytes(4).toString("hex")}`

// Short enough to sit in a URL a customer will paste into a chat window.
export const referralCode = (): string => randomBytes(4).toString("hex")

// RFC 5322 Message-ID, scoped to the sending domain.
export const rfcMessageId = (domain: string): string =>
  `<${randomUUID()}@${domain.replace(/^@/, "")}>`

// SMTP queue ids appear in Received headers and in every bounce a postmaster
// will quote back at you, so they are short and upper-case rather than a UUID.
export const queueId = (): string => base62(12).toUpperCase()

// IMAP UIDVALIDITY must strictly increase for a folder name that is recreated,
// and must fit in 32 unsigned bits. Seconds since the epoch does both until
// 2106 and is what every other server uses.
export const uidValidity = (): bigint => BigInt(Math.floor(Date.now() / 1000))

export const slug = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `item-${base62(6).toLowerCase()}`
