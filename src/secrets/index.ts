/**
 * Refuses a signing secret nobody should be running with.
 *
 * `JWT_SECRET` signs panel and webmail sessions, keys the SRS HMAC that stops a
 * forwarding address being an open relay, and (hashed) encrypts stored transfer
 * credentials. The shipped defaults are published in the repository, so a server
 * started with one has handed all three to anyone who can read it.
 */

const SHIPPED = ["corsair-dev-secret-change-me", "change-me-to-a-long-random-string"]
const MIN_LENGTH = 32

/** What is wrong with the secret, or null when it is acceptable. */
export const secretProblem = (secret: string): string | null => {
  if (SHIPPED.includes(secret) || secret.includes("change-me")) {
    return "JWT_SECRET is still a value from the repository."
  }
  if (secret.length < MIN_LENGTH) {
    return `JWT_SECRET is ${secret.length} characters; it needs at least ${MIN_LENGTH}.`
  }
  return null
}

export const assertSecret = (secret: string): void => {
  const problem = secretProblem(secret)
  if (problem) {
    throw new Error(`${problem} Generate one with: openssl rand -base64 48`)
  }
}

// per-purpose keys

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto"
import { config } from "../config/index.ts"

/**
 * What a key is for. One secret used for all of these meant a weakness in any
 * one was a weakness in every one: a signature oracle for sessions is also a
 * signature oracle for SRS, and an HMAC key and an AES key are not supposed to be
 * the same bytes. Each purpose gets its own key, derived with HKDF so that
 * knowing one reveals nothing about another.
 *
 * Derivation is domain separation, not extra secrecy: they all still come from
 * `JWT_SECRET`, so that remains the thing to protect, and changing it changes
 * them all.
 */
export type Purpose = "session" | "mailsession" | "srs" | "transfer"

const SALT = "corsair/key-derivation/v1"
const derived = new Map<string, Buffer>()

export const keyFor = (purpose: Purpose, secret: string = config.jwtSecret): Buffer => {
  const cacheKey = `${purpose}\0${secret}`
  let key = derived.get(cacheKey)
  if (!key) {
    key = Buffer.from(hkdfSync("sha256", secret, SALT, `corsair:${purpose}`, 32))
    derived.set(cacheKey, key)
  }
  return key
}

/** A derived key as a string, for APIs (JWT signing) that take one. */
export const secretFor = (purpose: Purpose): string => keyFor(purpose).toString("base64url")

// Encryption of a credential held only long enough to use it.

const legacyTransferKey = (): Buffer => createHash("sha256").update(config.jwtSecret).digest()

export const encryptSecret = (plain: string): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", keyFor("transfer"), iv)
  const payload = cipher.update(plain, "utf8", "base64") + cipher.final("base64")
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${payload}`
}

export const decryptSecret = (encrypted: string): string => {
  const [ivHex, tagHex, payload] = encrypted.split(":")
  if (!ivHex || !tagHex || !payload) return ""

  const open = (key: Buffer): string => {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"))
    decipher.setAuthTag(Buffer.from(tagHex, "hex"))
    return decipher.update(payload, "base64", "utf8") + decipher.final("utf8")
  }

  try {
    return open(keyFor("transfer"))
  } catch {
    // A transfer started before per-purpose keys, still running. Transfers erase
    // their stored password when they finish, so this path empties by itself;
    // it can go once none are left.
    return open(legacyTransferKey())
  }
}
