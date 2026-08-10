/**
 * An ESMTP session, as a state machine over lines.
 *
 * Deliberately transport-agnostic: it is fed bytes and returns bytes to write.
 * Nothing in here touches a socket, which is what makes the whole protocol —
 * pipelining, dot-stuffing, the AUTH handshake, the size limits — testable
 * without opening a port.
 */

export type SessionMode = "mx" | "submission"

export type Envelope = {
  helo: string
  mailFrom: string
  rcptTo: string[]
  size: number | null
  smtputf8: boolean
}

export type Reply = { code: number; message: string; enhanced?: string }

export type Identity = { username: string; id: string }

export type SessionHooks = {
  mode: SessionMode
  hostname: string
  maxSize: number
  remoteIp: string
  /** True once the connection is encrypted, however it got that way. */
  isSecure: () => boolean
  /** Present only when a certificate is configured; drives the STARTTLS advert. */
  startTls?: () => void
  authenticate?: (username: string, password: string) => Promise<Identity | null>
  validateSender: (address: string, identity: Identity | null) => Promise<Reply | null>
  validateRecipient: (
    address: string,
    identity: Identity | null,
    envelope: Envelope,
  ) => Promise<Reply | null>
  handleMessage: (envelope: Envelope, raw: string, identity: Identity | null) => Promise<Reply>
  onQuit?: () => void
}

const CRLF = "\r\n"

// RFC 5321 §4.5.3.1: 512 octets for a command line, 1000 for a message line.
// The larger cap here is deliberate slack for the non-conforming senders that
// exist in quantity; anything past it is a probe, not mail.
const MAX_COMMAND_LINE = 4096
const MAX_DATA_LINE = 65_536
const MAX_RECIPIENTS = 100
const MAX_BAD_COMMANDS = 10

const format = (reply: Reply): string => {
  const enhanced = reply.enhanced ? `${reply.enhanced} ` : ""
  const lines = reply.message.split("\n")
  return lines
    .map((line, index) =>
      index === lines.length - 1
        ? `${reply.code} ${enhanced}${line}`
        : `${reply.code}-${enhanced}${line}`,
    )
    .join(CRLF)
    .concat(CRLF)
}

const multiline = (code: number, lines: string[]): string =>
  lines
    .map((line, index) => (index === lines.length - 1 ? `${code} ${line}` : `${code}-${line}`))
    .join(CRLF)
    .concat(CRLF)

/** `MAIL FROM:<a@b>` and `RCPT TO:<a@b>` — angle brackets optional in the wild. */
const parsePath = (input: string): { address: string; params: Record<string, string> } | null => {
  const trimmed = input.trim()
  let address: string
  let rest: string

  if (trimmed.startsWith("<")) {
    const close = trimmed.indexOf(">")
    if (close === -1) return null
    address = trimmed.slice(1, close).trim()
    rest = trimmed.slice(close + 1)
  } else {
    const space = trimmed.indexOf(" ")
    address = space === -1 ? trimmed : trimmed.slice(0, space)
    rest = space === -1 ? "" : trimmed.slice(space)
  }

  const params: Record<string, string> = {}
  for (const token of rest.trim().split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf("=")
    if (eq === -1) params[token.toUpperCase()] = ""
    else params[token.slice(0, eq).toUpperCase()] = token.slice(eq + 1)
  }

  // A source route (`@relay:user@host`) is stripped, per RFC 5321 §4.1.1.3.
  if (address.startsWith("@")) {
    const colon = address.indexOf(":")
    if (colon !== -1) address = address.slice(colon + 1)
  }

  return { address, params }
}

const emptyEnvelope = (helo: string): Envelope => ({
  helo,
  mailFrom: "",
  rcptTo: [],
  size: null,
  smtputf8: false,
})

export type Session = {
  greeting: () => string
  /** Feeds received bytes and returns everything to write back. */
  feed: (chunk: Uint8Array | string) => Promise<string>
  shouldClose: () => boolean
  /** Set by the STARTTLS handler once the caller has upgraded the socket. */
  resetAfterTls: () => void
}

export const createSession = (hooks: SessionHooks): Session => {
  let buffer = ""
  let closing = false
  let inData = false
  let dataBuffer = ""
  let dataOverflow = false
  let greeted = false
  let helo = ""
  let identity: Identity | null = null
  let envelope = emptyEnvelope("")
  let badCommands = 0

  // AUTH runs across several lines, so the session has to remember which step
  // of which mechanism it is waiting on.
  let authState: { mechanism: "plain" | "login"; step: "user" | "pass"; username?: string } | null =
    null

  const canAdvertiseTls = (): boolean => Boolean(hooks.startTls) && !hooks.isSecure()
  // Credentials in the clear are worse than no submission at all. On a server
  // with no certificate configured this leaves AUTH unadvertised, which is the
  // correct failure: a self-hoster who has not set up TLS should discover it
  // here rather than after their customers' passwords have crossed the network.
  const canAuthenticate = (): boolean => Boolean(hooks.authenticate) && hooks.isSecure()

  const ehloLines = (): string[] => {
    const lines = [`${hooks.hostname} at your service`]
    lines.push(`SIZE ${hooks.maxSize}`)
    lines.push("8BITMIME")
    lines.push("SMTPUTF8")
    lines.push("PIPELINING")
    lines.push("ENHANCEDSTATUSCODES")
    // No CHUNKING: advertising it invites BDAT, and a sender that switches to
    // BDAT against a server with no BDAT gets a hard failure rather than
    // falling back to DATA.
    if (canAdvertiseTls()) lines.push("STARTTLS")
    if (canAuthenticate()) lines.push("AUTH PLAIN LOGIN")
    lines.push("HELP")
    return lines
  }

  const requireGreeting = (): string | null =>
    greeted ? null : format({ code: 503, enhanced: "5.5.1", message: "Send EHLO first." })

  const badCommand = (reply: Reply): string => {
    badCommands++
    if (badCommands >= MAX_BAD_COMMANDS) {
      closing = true
      return format({
        code: 421,
        enhanced: "4.7.0",
        message: "Too many errors on this connection. Goodbye.",
      })
    }
    return format(reply)
  }

  // ------------------------------------------------------------------ auth --

  const finishAuth = async (username: string, password: string): Promise<string> => {
    authState = null
    const result = await hooks.authenticate?.(username, password)
    if (!result) {
      return format({
        code: 535,
        enhanced: "5.7.8",
        message: "Authentication credentials invalid.",
      })
    }
    identity = result
    return format({ code: 235, enhanced: "2.7.0", message: "Authentication successful." })
  }

  const handleAuthLine = async (line: string): Promise<string> => {
    if (line === "*") {
      authState = null
      return format({ code: 501, enhanced: "5.7.0", message: "Authentication cancelled." })
    }

    let decoded: string
    try {
      decoded = Buffer.from(line, "base64").toString("utf8")
    } catch {
      authState = null
      return format({ code: 501, enhanced: "5.5.2", message: "Cannot decode base64." })
    }

    const state = authState!
    if (state.mechanism === "plain") {
      // authzid \0 authcid \0 password
      const parts = decoded.split("\0")
      const username = parts[1] ?? ""
      const password = parts[2] ?? ""
      if (!username || !password) {
        authState = null
        return format({ code: 501, enhanced: "5.5.2", message: "Malformed AUTH PLAIN payload." })
      }
      return finishAuth(username, password)
    }

    if (state.step === "user") {
      authState = { mechanism: "login", step: "pass", username: decoded }
      return `334 ${Buffer.from("Password:").toString("base64")}${CRLF}`
    }
    return finishAuth(state.username ?? "", decoded)
  }

  const startAuth = async (argument: string): Promise<string> => {
    if (!canAuthenticate()) {
      return format({
        code: 538,
        enhanced: "5.7.11",
        message: "Encryption required for requested authentication mechanism.",
      })
    }
    if (identity) {
      return format({ code: 503, enhanced: "5.5.1", message: "Already authenticated." })
    }
    if (envelope.mailFrom) {
      return format({
        code: 503,
        enhanced: "5.5.1",
        message: "AUTH not permitted during a transaction.",
      })
    }

    const [mechanismRaw = "", initial = ""] = argument.trim().split(/\s+/)
    const mechanism = mechanismRaw.toLowerCase()

    if (mechanism === "plain") {
      if (initial) {
        authState = { mechanism: "plain", step: "pass" }
        return handleAuthLine(initial)
      }
      authState = { mechanism: "plain", step: "pass" }
      return `334 ${CRLF}`
    }
    if (mechanism === "login") {
      if (initial) {
        authState = { mechanism: "login", step: "user" }
        return handleAuthLine(initial)
      }
      authState = { mechanism: "login", step: "user" }
      return `334 ${Buffer.from("Username:").toString("base64")}${CRLF}`
    }
    return format({
      code: 504,
      enhanced: "5.5.4",
      message: "Unrecognized authentication type.",
    })
  }

  // ------------------------------------------------------------- commands --

  const handleCommand = async (line: string): Promise<string> => {
    const space = line.indexOf(" ")
    const verb = (space === -1 ? line : line.slice(0, space)).toUpperCase()
    const argument = space === -1 ? "" : line.slice(space + 1)

    switch (verb) {
      case "EHLO": {
        if (!argument.trim()) {
          return badCommand({ code: 501, enhanced: "5.5.4", message: "EHLO requires a domain." })
        }
        greeted = true
        helo = argument.trim()
        // A second EHLO resets the transaction but keeps the authenticated
        // identity — clients re-EHLO after STARTTLS and after AUTH.
        envelope = emptyEnvelope(helo)
        return multiline(250, ehloLines())
      }

      case "HELO": {
        if (!argument.trim()) {
          return badCommand({ code: 501, enhanced: "5.5.4", message: "HELO requires a domain." })
        }
        greeted = true
        helo = argument.trim()
        envelope = emptyEnvelope(helo)
        return format({ code: 250, message: `${hooks.hostname} at your service` })
      }

      case "STARTTLS": {
        if (!hooks.startTls) {
          return badCommand({ code: 502, enhanced: "5.5.1", message: "STARTTLS is not available." })
        }
        if (hooks.isSecure()) {
          return badCommand({ code: 503, enhanced: "5.5.1", message: "TLS is already active." })
        }
        // The caller upgrades the socket as soon as this reply has been
        // flushed; everything negotiated so far is discarded because a
        // pre-TLS EHLO cannot be trusted.
        hooks.startTls()
        return format({ code: 220, enhanced: "2.0.0", message: "Ready to start TLS." })
      }

      case "AUTH":
        return startAuth(argument)

      case "MAIL": {
        const pending = requireGreeting()
        if (pending) return pending
        if (envelope.mailFrom) {
          return badCommand({ code: 503, enhanced: "5.5.1", message: "Sender already specified." })
        }
        const match = argument.match(/^FROM:\s*(.*)$/i)
        if (!match) {
          return badCommand({
            code: 501,
            enhanced: "5.5.4",
            message: "Syntax: MAIL FROM:<address>",
          })
        }
        const path = parsePath(match[1]!)
        if (!path) {
          return badCommand({ code: 501, enhanced: "5.1.7", message: "Malformed sender address." })
        }

        const declared = path.params.SIZE ? Number(path.params.SIZE) : null
        if (declared && declared > hooks.maxSize) {
          return format({
            code: 552,
            enhanced: "5.3.4",
            message: `Message size exceeds the ${hooks.maxSize} byte limit.`,
          })
        }

        const rejection = await hooks.validateSender(path.address, identity)
        if (rejection) return format(rejection)

        envelope = {
          ...emptyEnvelope(helo),
          mailFrom: path.address,
          size: declared,
          smtputf8: "SMTPUTF8" in path.params,
        }
        return format({ code: 250, enhanced: "2.1.0", message: "Sender OK." })
      }

      case "RCPT": {
        const pending = requireGreeting()
        if (pending) return pending
        if (!envelope.mailFrom) {
          return badCommand({ code: 503, enhanced: "5.5.1", message: "Send MAIL FROM first." })
        }
        if (envelope.rcptTo.length >= MAX_RECIPIENTS) {
          return format({ code: 452, enhanced: "4.5.3", message: "Too many recipients." })
        }
        const match = argument.match(/^TO:\s*(.*)$/i)
        if (!match) {
          return badCommand({ code: 501, enhanced: "5.5.4", message: "Syntax: RCPT TO:<address>" })
        }
        const path = parsePath(match[1]!)
        if (!path?.address) {
          return badCommand({
            code: 501,
            enhanced: "5.1.3",
            message: "Malformed recipient address.",
          })
        }

        const rejection = await hooks.validateRecipient(path.address, identity, envelope)
        if (rejection) return format(rejection)

        envelope = { ...envelope, rcptTo: [...envelope.rcptTo, path.address] }
        return format({ code: 250, enhanced: "2.1.5", message: "Recipient OK." })
      }

      case "DATA": {
        const pending = requireGreeting()
        if (pending) return pending
        if (!envelope.mailFrom) {
          return badCommand({ code: 503, enhanced: "5.5.1", message: "Send MAIL FROM first." })
        }
        if (!envelope.rcptTo.length) {
          return badCommand({ code: 554, enhanced: "5.5.1", message: "No valid recipients." })
        }
        inData = true
        dataBuffer = ""
        dataOverflow = false
        return format({ code: 354, message: "End data with <CR><LF>.<CR><LF>" })
      }

      case "RSET":
        envelope = emptyEnvelope(helo)
        inData = false
        dataBuffer = ""
        return format({ code: 250, enhanced: "2.0.0", message: "Reset." })

      case "NOOP":
        return format({ code: 250, enhanced: "2.0.0", message: "OK." })

      case "QUIT":
        closing = true
        hooks.onQuit?.()
        return format({
          code: 221,
          enhanced: "2.0.0",
          message: `${hooks.hostname} closing connection.`,
        })

      case "VRFY":
        // Confirming which addresses exist is a gift to a spammer compiling a
        // list, so this always answers the same way regardless of the argument.
        return format({
          code: 252,
          enhanced: "2.5.2",
          message: "Cannot VRFY user, but will accept message and attempt delivery.",
        })

      case "EXPN":
        return format({ code: 502, enhanced: "5.7.0", message: "EXPN is not supported." })

      case "HELP":
        return format({
          code: 214,
          enhanced: "2.0.0",
          message: "Commands: EHLO STARTTLS AUTH MAIL RCPT DATA RSET NOOP VRFY QUIT",
        })

      default:
        return badCommand({
          code: 500,
          enhanced: "5.5.2",
          message: `Unrecognized command: ${verb}`,
        })
    }
  }

  // ------------------------------------------------------------ data phase --

  const handleDataLine = async (line: string): Promise<string | null> => {
    if (line === ".") {
      inData = false
      const raw = dataBuffer
      const finished = envelope
      envelope = emptyEnvelope(helo)
      dataBuffer = ""

      if (dataOverflow) {
        return format({
          code: 552,
          enhanced: "5.3.4",
          message: `Message exceeds the ${hooks.maxSize} byte limit.`,
        })
      }

      const reply = await hooks.handleMessage(finished, raw, identity)
      return format(reply)
    }

    // Dot-stuffing: a body line starting with "." was sent with an extra one.
    const unstuffed = line.startsWith(".") ? line.slice(1) : line

    if (dataBuffer.length + unstuffed.length + 2 > hooks.maxSize) {
      // Keep reading to the terminating dot so the connection stays in sync;
      // dropping the socket here would make the sender retry forever.
      dataOverflow = true
      return null
    }
    dataBuffer += unstuffed + CRLF
    return null
  }

  // ---------------------------------------------------------------- feed --

  return {
    greeting: () =>
      format({
        code: 220,
        message: `${hooks.hostname} ESMTP Corsair`,
      }),

    feed: async (chunk) => {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1")

      let out = ""
      while (true) {
        const index = buffer.indexOf(CRLF)
        // A bare LF is not legal, but enough senders emit it that refusing is a
        // deliverability problem rather than a standards win.
        const bare = buffer.indexOf("\n")
        const useBare = index === -1 && bare !== -1
        if (index === -1 && !useBare) {
          const limit = inData ? MAX_DATA_LINE : MAX_COMMAND_LINE
          if (buffer.length > limit) {
            buffer = ""
            closing = true
            out += format({ code: 500, enhanced: "5.5.2", message: "Line too long." })
          }
          break
        }

        const end = useBare ? bare : index
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + (useBare ? 1 : 2))

        if (inData) {
          const reply = await handleDataLine(line)
          if (reply) out += reply
          continue
        }
        if (authState) {
          out += await handleAuthLine(line.trim())
          continue
        }
        if (!line.trim()) continue
        out += await handleCommand(line.trim())
        if (closing) break
      }
      return out
    },

    shouldClose: () => closing,

    resetAfterTls: () => {
      buffer = ""
      greeted = false
      helo = ""
      identity = null
      envelope = emptyEnvelope("")
      authState = null
      inData = false
      dataBuffer = ""
    },
  }
}
