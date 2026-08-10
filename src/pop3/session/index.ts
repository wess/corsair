import { createHash, randomBytes } from "node:crypto"
import { inboxOf } from "../../addresses/index.ts"
import { authenticateAddress, type MailIdentity } from "../../auth/index.ts"
import { config } from "../../config/index.ts"
import { num } from "../../db/index.ts"
import * as mime from "../../mime/index.ts"
import type { Message } from "../../schema/index.ts"
import { getRaw } from "../../storage/index.ts"
import { expunge, messagesIn } from "../../store/index.ts"

/** The raw bytes of a stored message, whichever backend holds them. */
const loadRaw = (message: Message): Promise<string | null> =>
  getRaw({ storageKey: message.storage_key, messageId: message.id })

const CRLF = "\r\n"

/**
 * POP3 (RFC 1939).
 *
 * The model is a snapshot: the mailbox is listed once at authentication and the
 * numbering is frozen for the session, because POP3 message numbers must not
 * move underneath a client mid-transaction. Deletions are marked and only
 * applied at QUIT, which is what the specification's UPDATE state means and
 * what makes a dropped connection safe — nothing is lost.
 *
 * Only the INBOX is served. POP3 has no concept of folders, and every client
 * that speaks it expects exactly one mailbox.
 */

export type Pop3Hooks = {
  isSecure: () => boolean
  startTls?: () => void
  remoteIp: string
  onAuthSuccess?: () => void
  onAuthFailure?: (username: string) => void
}

export type Pop3Session = {
  greeting: () => string
  feed: (chunk: Uint8Array | string) => Promise<string>
  shouldClose: () => boolean
  resetAfterTls: () => void
}

type Entry = { message: Message; size: number; deleted: boolean }

export const createPop3Session = (hooks: Pop3Hooks): Pop3Session => {
  let buffer = ""
  let closing = false
  let identity: MailIdentity | null = null
  let pendingUser: string | null = null
  let entries: Entry[] = []

  // The APOP timestamp is part of the greeting and is what the digest is
  // computed over. It has to be unique per connection or the digest is
  // replayable — and two connections do arrive in the same millisecond, so the
  // clock alone is not enough.
  const stamp = `<${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}@${config.hostname}>`

  const ok = (message: string) => `+OK ${message}${CRLF}`
  const err = (message: string) => `-ERR ${message}${CRLF}`

  const live = (): Entry[] => entries.filter((e) => !e.deleted)

  const entryAt = (index: number): Entry | null => {
    const entry = entries[index - 1]
    if (!entry || entry.deleted) return null
    return entry
  }

  const loadMailbox = async () => {
    if (!identity) return
    const inbox = await inboxOf(identity.address.id)
    const rows = await messagesIn(inbox.id)
    entries = rows.map((message) => ({ message, size: message.size, deleted: false }))
  }

  const finishAuth = async (username: string, password: string): Promise<string> => {
    const result = await authenticateAddress(username, password)
    if (!result) {
      hooks.onAuthFailure?.(username)
      return err("Invalid credentials.")
    }
    identity = result
    hooks.onAuthSuccess?.()
    await loadMailbox()
    return ok(`Mailbox ready, ${live().length} message(s).`)
  }

  /**
   * A message's unique identifier, stable across sessions.
   *
   * POP3 clients that "leave mail on the server" use UIDL to decide what they
   * have already downloaded, so this must never change for a given message and
   * must never be reused — the row id satisfies both, hashed only to keep it in
   * the character set the specification allows.
   */
  const uidl = (message: Message): string =>
    createHash("sha1").update(message.id).digest("hex").slice(0, 32)

  const handle = async (line: string): Promise<string> => {
    const space = line.indexOf(" ")
    const verb = (space === -1 ? line : line.slice(0, space)).toUpperCase()
    const argument = space === -1 ? "" : line.slice(space + 1).trim()

    switch (verb) {
      case "CAPA": {
        const caps = ["TOP", "UIDL", "USER", "RESP-CODES", "PIPELINING"]
        if (hooks.startTls && !hooks.isSecure()) caps.push("STLS")
        if (hooks.isSecure()) caps.push("SASL PLAIN")
        return `+OK Capability list follows${CRLF}${caps.join(CRLF)}${CRLF}.${CRLF}`
      }

      case "STLS":
        if (!hooks.startTls) return err("STLS is not available.")
        if (hooks.isSecure()) return err("TLS is already active.")
        hooks.startTls()
        return ok("Begin TLS negotiation.")

      case "USER":
        if (identity) return err("Already authenticated.")
        if (!hooks.isSecure()) return err("Encryption required before authenticating.")
        pendingUser = argument
        return ok("Send PASS.")

      case "PASS": {
        if (identity) return err("Already authenticated.")
        if (!pendingUser) return err("Send USER first.")
        const username = pendingUser
        pendingUser = null
        return finishAuth(username, argument)
      }

      case "APOP": {
        if (identity) return err("Already authenticated.")
        // APOP proves knowledge of the password without sending it, but it
        // requires the server to hold the password in a recoverable form. This
        // one stores an Argon2 hash, so the digest cannot be checked — saying
        // so is better than failing in a way that looks like a wrong password.
        return err("APOP is not supported; use STLS with USER/PASS.")
      }

      case "QUIT": {
        closing = true
        if (!identity) return ok("Goodbye.")
        const removed = entries.filter((e) => e.deleted)
        if (removed.length) {
          const inbox = await inboxOf(identity.address.id)
          await expunge({
            folderId: inbox.id,
            messageIds: removed.map((e) => e.message.id),
          })
        }
        return ok(`Goodbye. ${removed.length} message(s) deleted.`)
      }
    }

    if (!identity) return err("Authenticate first.")

    switch (verb) {
      case "STAT": {
        const kept = live()
        const bytes = kept.reduce((sum, e) => sum + e.size, 0)
        return ok(`${kept.length} ${bytes}`)
      }

      case "LIST": {
        if (argument) {
          const entry = entryAt(Number(argument))
          return entry ? ok(`${argument} ${entry.size}`) : err("No such message.")
        }
        const kept = live()
        const lines = entries
          .map((entry, index) => (entry.deleted ? null : `${index + 1} ${entry.size}`))
          .filter(Boolean)
        return `+OK ${kept.length} message(s)${CRLF}${lines.join(CRLF)}${lines.length ? CRLF : ""}.${CRLF}`
      }

      case "UIDL": {
        if (argument) {
          const entry = entryAt(Number(argument))
          return entry ? ok(`${argument} ${uidl(entry.message)}`) : err("No such message.")
        }
        const lines = entries
          .map((entry, index) => (entry.deleted ? null : `${index + 1} ${uidl(entry.message)}`))
          .filter(Boolean)
        return `+OK${CRLF}${lines.join(CRLF)}${lines.length ? CRLF : ""}.${CRLF}`
      }

      case "RETR": {
        const entry = entryAt(Number(argument))
        if (!entry) return err("No such message.")
        const raw = await loadRaw(entry.message)
        if (raw === null) return err("Message body is no longer available.")
        return `+OK ${raw.length} octets${CRLF}${stuff(raw)}.${CRLF}`
      }

      case "TOP": {
        const [numberPart = "", linesPart = "0"] = argument.split(/\s+/)
        const entry = entryAt(Number(numberPart))
        if (!entry) return err("No such message.")
        const raw = await loadRaw(entry.message)
        if (raw === null) return err("Message body is no longer available.")

        const parsed = mime.parseMessage(raw)
        const headers = raw.slice(0, parsed.bodyStart)
        const body = raw.slice(parsed.bodyStart)
        const wanted = Math.max(0, Number(linesPart) || 0)
        const lines = body.split(CRLF).slice(0, wanted)
        const payload = `${headers}${lines.join(CRLF)}${lines.length ? CRLF : ""}`
        return `+OK Top of message follows${CRLF}${stuff(payload)}.${CRLF}`
      }

      case "DELE": {
        const index = Number(argument)
        const entry = entryAt(index)
        if (!entry) return err("No such message.")
        entry.deleted = true
        return ok(`Message ${index} marked for deletion.`)
      }

      case "RSET":
        // Undoes every DELE in this session, which is the whole point of
        // deferring them to QUIT.
        for (const entry of entries) entry.deleted = false
        return ok(`${entries.length} message(s) restored.`)

      case "NOOP":
        return ok("")

      default:
        return err(`Unknown command: ${verb}`)
    }
  }

  /** Byte-stuffs a leading dot so it cannot terminate the response early. */
  const stuff = (raw: string): string => {
    const normalized = mime.normalizeEol(raw)
    const stuffed = normalized.replace(/(^|\r\n)\./g, "$1..")
    return stuffed.endsWith(CRLF) ? stuffed : `${stuffed}${CRLF}`
  }

  return {
    greeting: () => `+OK ${config.hostname} Corsair POP3 ready ${stamp}${CRLF}`,

    feed: async (chunk) => {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1")
      let out = ""

      while (true) {
        const end = buffer.indexOf(CRLF)
        const bare = buffer.indexOf("\n")
        const useBare = end === -1 && bare !== -1
        if (end === -1 && !useBare) {
          if (buffer.length > 4096) {
            buffer = ""
            closing = true
            out += err("Line too long.")
          }
          break
        }

        const at = useBare ? bare : end
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + (useBare ? 1 : 2))
        if (!line.trim()) continue

        out += await handle(line.trim())
        if (closing) break
      }

      return out
    },

    shouldClose: () => closing,

    resetAfterTls: () => {
      buffer = ""
      identity = null
      pendingUser = null
      entries = []
    },
  }
}

export const messageUidl = (message: Message): string =>
  createHash("sha1").update(message.id).digest("hex").slice(0, 32)

export { num }
