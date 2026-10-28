import { authenticateAddress, type MailIdentity } from "../../auth/index.ts"
import { config } from "../../config/index.ts"
import { entitlementOf, requireFeature } from "../../plans/index.ts"
import * as sieve from "../../sieve/index.ts"
import { type Limits, parseCommand, type Token } from "../parse/index.ts"
import {
  activeScriptId,
  countScripts,
  findScript,
  listScripts,
  MAX_SCRIPTS,
  removeScript,
  renameScript,
  saveScript,
  setActive,
} from "../scripts/index.ts"

const CRLF = "\r\n"

/**
 * ManageSieve (RFC 5804): the protocol Thunderbird, Roundcube and K-9 use to
 * edit a mailbox's Sieve script.
 *
 * It is a window onto the `filters` table, not a store of its own — see
 * `../scripts`. Scripts belong to the account, so only a mailbox that *is* its
 * owner's account may use it: any other mailbox (a family member's, an agent's)
 * would otherwise be editing somebody else's filters.
 */

export type ManageSieveHooks = {
  isSecure: () => boolean
  startTls?: () => void
  remoteIp: string
  onAuthSuccess?: () => void
  onAuthFailure?: (username: string) => void
}

export type ManageSieveSession = {
  greeting: () => string
  feed: (chunk: Uint8Array | string) => Promise<string>
  shouldClose: () => boolean
  /** Forgets everything learned in the clear; returns the capabilities the client must re-read. */
  resetAfterTls: () => string
}

/** Same ceiling as `POST /api/filters`, so a script saved here can be saved again there. */
export const MAX_SCRIPT_BYTES = 64_000
const MAX_NAME = 120
const PRE_AUTH_BYTES = 8 * 1024

const UNAUTHENTICATED: Limits = {
  line: PRE_AUTH_BYTES,
  literal: PRE_AUTH_BYTES,
  total: PRE_AUTH_BYTES,
}
const AUTHENTICATED: Limits = {
  line: PRE_AUTH_BYTES,
  literal: MAX_SCRIPT_BYTES,
  total: MAX_SCRIPT_BYTES + PRE_AUTH_BYTES,
}

const toWire = (value: string): string => Buffer.from(value, "utf8").toString("latin1")

/** Decodes wire bytes as UTF-8, or null when they are not (or hold a NUL, which Postgres refuses). */
const fromWire = (value: string): string | null => {
  const text = Buffer.from(value, "latin1").toString("utf8")
  return text.includes("�") || text.includes("\0") ? null : text
}

/** A string as the server sends it: quoted when it can be, a literal when it must be. */
const str = (value: string): string => {
  const wire = toWire(value)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: this is the point
  return /[\x00-\x1f\x7f]/.test(value)
    ? `{${wire.length}}${CRLF}${wire}`
    : `"${wire.replace(/[\\"]/g, "\\$&")}"`
}

const reply = (kind: "OK" | "NO" | "BYE", message?: string, code?: string): string =>
  `${kind}${code ? ` (${code})` : ""}${message ? ` ${str(message)}` : ""}${CRLF}`

export const createManageSieveSession = (hooks: ManageSieveHooks): ManageSieveSession => {
  let buffer = ""
  let closing = false
  let upgrade = false
  let identity: MailIdentity | null = null
  let userId = ""
  // Set between `AUTHENTICATE "PLAIN"` and the client's response string.
  let awaitingPlain = false

  const ok = (message?: string, code?: string) => reply("OK", message, code)
  const no = (message?: string, code?: string) => reply("NO", message, code)

  const capabilities = (): string => {
    const lines = [
      `"IMPLEMENTATION" "Corsair"`,
      // Empty before TLS: advertising PLAIN would invite a password in the clear.
      `"SASL" "${!identity && hooks.isSecure() ? "PLAIN" : ""}"`,
      `"SIEVE" "${sieve.EXTENSIONS.join(" ")}"`,
    ]
    if (hooks.startTls && !hooks.isSecure() && !identity) lines.push(`"STARTTLS"`)
    lines.push(`"VERSION" "1.0"`)
    return lines.join(CRLF) + CRLF
  }

  const finishAuth = async (username: string, password: string): Promise<string> => {
    const result = await authenticateAddress(username, password, hooks.remoteIp)
    if (!result) {
      hooks.onAuthFailure?.(username)
      return no("Authentication failed.")
    }
    hooks.onAuthSuccess?.()
    // Right credentials, wrong door. Not recorded as a failure: nobody is guessing.
    if (!result.address.user_id) {
      return no("Filters for this mailbox are managed by the account owner.")
    }
    identity = result
    userId = result.address.user_id
    return ok("Logged in.")
  }

  const plain = (response: string): Promise<string> | string => {
    if (response === "*") return no("Authentication cancelled.")
    const decoded = Buffer.from(response, "base64").toString("utf8").split("\0")
    if (decoded.length !== 3) return no("Malformed PLAIN response.")
    const [authzid = "", authcid = "", password = ""] = decoded
    // No proxy authorisation: acting as someone else is not a feature of this server.
    if (authzid && authzid !== authcid) return no("Authorization identity not permitted.")
    return finishAuth(authcid, password)
  }

  const scriptName = (token: Token | undefined): string | null => {
    if (!token) return null
    const name = fromWire(token.value)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: names with controls are refused
    if (!name || name.length > MAX_NAME || /[\x00-\x1f\x7f]/.test(name)) return null
    return name
  }

  const badName = () => no("Invalid script name.")

  const filtersAllowed = async (): Promise<string | null> => {
    try {
      requireFeature(await entitlementOf(userId), "custom_filters", "custom filters")
      return null
    } catch {
      return no("Your current plan does not include custom filters.", "QUOTA")
    }
  }

  const body = (token: Token | undefined): { text: string } | { error: string } => {
    if (!token) return { error: no("Missing script.") }
    const text = fromWire(token.value)
    if (text === null) return { error: no("Scripts must be UTF-8.") }
    if (Buffer.byteLength(text) > MAX_SCRIPT_BYTES) {
      return { error: no("Script is too large.", "QUOTA/MAXSIZE") }
    }
    return { text }
  }

  const handle = async (tokens: Token[]): Promise<string> => {
    const verb = (tokens[0]?.value ?? "").toUpperCase()
    const args = tokens.slice(1)

    switch (verb) {
      case "CAPABILITY":
        return capabilities() + ok("Capability completed.")

      case "NOOP":
        return ok("Done.", args[0] ? `TAG ${str(args[0].value)}` : undefined)

      case "LOGOUT":
        closing = true
        return ok("Logout completed.")

      case "STARTTLS":
        if (!hooks.startTls) return no("STARTTLS is not available.")
        if (hooks.isSecure()) return no("TLS is already active.")
        if (identity) return no("Already authenticated.")
        upgrade = true
        return ok("Begin TLS negotiation now.")

      case "AUTHENTICATE": {
        if (identity) return no("Already authenticated.")
        // Same rule as IMAP and POP3: no password crosses the wire in the clear.
        if (!hooks.isSecure())
          return no("Encryption required before AUTHENTICATE.", "ENCRYPT-NEEDED")
        if (args[0]?.value.toUpperCase() !== "PLAIN") return no("Unsupported SASL mechanism.")
        // SASL-IR: the response may ride on the command, or follow an empty challenge.
        if (args[1]) return plain(args[1].value)
        awaitingPlain = true
        return `""${CRLF}`
      }
    }

    if (!identity) return no("Authenticate first.")

    switch (verb) {
      case "UNAUTHENTICATE":
        identity = null
        userId = ""
        return ok("Logged out.")

      case "LISTSCRIPTS": {
        const [rows, active] = await Promise.all([
          listScripts(userId),
          activeScriptId(identity.address.id),
        ])
        return (
          rows.map((r) => `${str(r.name)}${r.id === active ? " ACTIVE" : ""}${CRLF}`).join("") +
          ok("Listscripts completed.")
        )
      }

      case "GETSCRIPT": {
        const name = scriptName(args[0])
        if (!name) return badName()
        const found = await findScript(userId, name)
        if (!found) return no("No such script.", "NONEXISTENT")
        const wire = toWire(found.script)
        return `{${wire.length}}${CRLF}${wire}${CRLF}${ok("Getscript completed.")}`
      }

      case "HAVESPACE": {
        const name = scriptName(args[0])
        if (!name) return badName()
        const size = Number(args[1]?.value)
        if (!Number.isInteger(size) || size < 0) return no("Invalid size.")
        if (size > MAX_SCRIPT_BYTES) return no("Script is too large.", "QUOTA/MAXSIZE")
        const blocked = await filtersAllowed()
        if (blocked) return blocked
        return ok("Havespace completed.")
      }

      case "CHECKSCRIPT": {
        const script = body(args[0])
        if ("error" in script) return script.error
        const result = sieve.compile(script.text)
        return result.ok ? ok("Script is valid.") : no(result.error)
      }

      case "PUTSCRIPT": {
        const name = scriptName(args[0])
        if (!name) return badName()
        const script = body(args[1])
        if ("error" in script) return script.error
        const blocked = await filtersAllowed()
        if (blocked) return blocked
        const compiled = sieve.compile(script.text)
        if (!compiled.ok) return no(compiled.error)
        if (!(await findScript(userId, name)) && (await countScripts(userId)) >= MAX_SCRIPTS) {
          return no("Too many scripts.", "QUOTA/MAXSCRIPTS")
        }
        await saveScript(userId, name, script.text)
        return ok("Putscript completed.")
      }

      case "SETACTIVE": {
        // The empty name deactivates, per RFC 5804 §2.8.
        if (args[0]?.value === "") {
          await setActive(identity.address.id, null)
          return ok("Setactive completed.")
        }
        const name = scriptName(args[0])
        if (!name) return badName()
        const found = await findScript(userId, name)
        if (!found) return no("No such script.", "NONEXISTENT")
        await setActive(identity.address.id, found.id)
        return ok("Setactive completed.")
      }

      case "DELETESCRIPT": {
        const name = scriptName(args[0])
        if (!name) return badName()
        const found = await findScript(userId, name)
        if (!found) return no("No such script.", "NONEXISTENT")
        if ((await activeScriptId(identity.address.id)) === found.id) {
          return no("Cannot delete the active script.", "ACTIVE")
        }
        await removeScript(userId, found.id)
        return ok("Deletescript completed.")
      }

      case "RENAMESCRIPT": {
        const from = scriptName(args[0])
        const to = scriptName(args[1])
        if (!from || !to) return badName()
        const found = await findScript(userId, from)
        if (!found) return no("No such script.", "NONEXISTENT")
        const blocked = await filtersAllowed()
        if (blocked) return blocked
        if (!(await renameScript(userId, found.id, to))) {
          return no("A script with that name already exists.", "ALREADYEXISTS")
        }
        return ok("Renamescript completed.")
      }
    }

    return no("Unknown command.")
  }

  return {
    greeting: () => capabilities() + ok(`${config.hostname} Corsair ManageSieve ready.`),

    async feed(chunk) {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1")
      let out = ""

      while (!closing && !upgrade) {
        const parsed = parseCommand(buffer, identity ? AUTHENTICATED : UNAUTHENTICATED)
        if (parsed.status === "more") break
        if (parsed.status === "bad") {
          out +=
            parsed.reason === "toolarge"
              ? no("Script is too large.", "QUOTA/MAXSIZE")
              : no("Syntax error.")
          out += reply("BYE", "Closing connection.")
          closing = true
          break
        }

        buffer = buffer.slice(parsed.used)
        const { tokens } = parsed
        if (awaitingPlain) {
          awaitingPlain = false
          out += tokens.length === 1 ? await plain(tokens[0]!.value) : no("Malformed response.")
        } else if (tokens.length) {
          out += await handle(tokens)
        } else {
          out += no("Syntax error.")
        }
      }

      // Bytes pipelined behind STARTTLS were sent in the clear, before the
      // handshake; whoever injected them is not who ends up on the TLS side.
      if (upgrade) {
        if (buffer) {
          buffer = ""
          upgrade = false
          closing = true
          out += reply("BYE", "Data received before TLS was established.")
        } else {
          upgrade = false
          hooks.startTls?.()
        }
      }
      return out
    },

    shouldClose: () => closing,

    resetAfterTls() {
      buffer = ""
      upgrade = false
      awaitingPlain = false
      return capabilities()
    },
  }
}
