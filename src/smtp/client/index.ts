import { resolveMx } from "node:dns/promises"
import { config } from "../../config/index.ts"

/**
 * An SMTP client, used to hand a message to somebody else's server.
 *
 * Written against Bun.connect rather than a library because the interesting
 * behaviour here is not "send a mail" — it is distinguishing a 4xx that should
 * be retried from a 5xx that should bounce, and surviving the many servers that
 * are almost but not quite conforming. That logic has to be ours either way.
 */

const CRLF = "\r\n"

export type SendResult = {
  ok: boolean
  /** True when the failure is worth retrying: a 4xx, or the connection itself. */
  retryable: boolean
  code: number
  message: string
  host: string | null
}

export type SendInput = {
  host: string
  port?: number
  mailFrom: string
  rcptTo: string
  raw: string
  /** Implicit TLS from the first byte, as on port 465. */
  implicitTls?: boolean
  auth?: { user: string; pass: string }
  timeoutMs?: number
}

type Conn = {
  read: (expect?: number) => Promise<{ code: number; text: string }>
  write: (line: string) => void
  upgrade: () => Promise<void>
  close: () => void
  secure: () => boolean
}

class SmtpFailure extends Error {
  readonly code: number
  readonly retryable: boolean
  constructor(code: number, message: string, retryable: boolean) {
    super(message)
    this.name = "SmtpFailure"
    this.code = code
    this.retryable = retryable
  }
}

/**
 * A reply is complete when a line has a space rather than a hyphen after the
 * code. Reading "the next line" is not enough: greetings and EHLO answers are
 * routinely multi-line, and treating the first line as the whole reply is the
 * classic way to desynchronise a client.
 */
const parseReply = (buffer: string): { code: number; text: string; rest: string } | null => {
  const lines: string[] = []
  let remaining = buffer
  while (true) {
    const end = remaining.indexOf(CRLF)
    if (end === -1) return null
    const line = remaining.slice(0, end)
    lines.push(line)
    remaining = remaining.slice(end + 2)
    if (/^\d{3} /.test(line)) {
      return {
        code: Number(line.slice(0, 3)),
        text: lines.join("\n"),
        rest: remaining,
      }
    }
    if (!/^\d{3}-/.test(line)) {
      // Not a reply at all. Bail rather than spin.
      return { code: 421, text: lines.join("\n"), rest: remaining }
    }
  }
}

const connect = async (input: {
  host: string
  port: number
  tls: boolean
  timeoutMs: number
}): Promise<Conn> => {
  let buffer = ""
  let closed = false
  let secure = input.tls
  let notify: (() => void) | null = null

  const handlers = {
    data(_socket: unknown, data: Uint8Array) {
      buffer += Buffer.from(data).toString("latin1")
      notify?.()
    },
    close() {
      closed = true
      notify?.()
    },
    error() {
      closed = true
      notify?.()
    },
  }

  let socket = await Bun.connect({
    hostname: input.host,
    port: input.port,
    ...(input.tls ? { tls: true } : {}),
    socket: handlers as never,
  })

  const read = async (expect?: number): Promise<{ code: number; text: string }> => {
    const deadline = Date.now() + input.timeoutMs
    while (true) {
      const parsed = parseReply(buffer)
      if (parsed) {
        buffer = parsed.rest
        if (expect && Math.floor(parsed.code / 100) !== Math.floor(expect / 100)) {
          // 4xx is transient, 5xx is permanent. Anything else from a server
          // this confused is treated as transient — retrying costs a
          // connection, giving up loses the mail.
          throw new SmtpFailure(parsed.code, parsed.text, parsed.code < 500)
        }
        return parsed
      }
      if (closed) throw new SmtpFailure(421, "Connection closed by the remote server.", true)
      if (Date.now() > deadline) throw new SmtpFailure(421, "Timed out waiting for a reply.", true)
      await new Promise<void>((resolve) => {
        notify = resolve
        setTimeout(resolve, 250)
      })
      notify = null
    }
  }

  return {
    read,
    write: (line) => {
      socket.write(line)
    },
    upgrade: async () => {
      const [, tls] = socket.upgradeTLS({
        socket: handlers as never,
        // A mail server's certificate is very often self-signed or expired, and
        // refusing to deliver on that basis loses real mail. Opportunistic TLS
        // is about passive eavesdropping, not authentication, so the connection
        // is encrypted but the certificate is not enforced.
        tls: { rejectUnauthorized: false, serverName: input.host },
      })
      socket = tls as never
      secure = true
    },
    close: () => {
      try {
        socket.end()
      } catch {
        // Already gone.
      }
    },
    secure: () => secure,
  }
}

/** Dot-stuffs the body and appends the terminator. */
const dataPayload = (raw: string): string => {
  const normalized = raw.replace(/\r\n|\r|\n/g, CRLF)
  const stuffed = normalized.replace(/(^|\r\n)\./g, "$1..")
  const trailing = stuffed.endsWith(CRLF) ? "" : CRLF
  return `${stuffed}${trailing}.${CRLF}`
}

export const sendMessage = async (input: SendInput): Promise<SendResult> => {
  const port = input.port ?? 25
  const timeoutMs = input.timeoutMs ?? 60_000
  let conn: Conn | null = null

  try {
    conn = await connect({
      host: input.host,
      port,
      tls: Boolean(input.implicitTls),
      timeoutMs,
    })

    await conn.read(220)

    conn.write(`EHLO ${config.hostname}${CRLF}`)
    let greeting = await conn.read(250)

    if (!conn.secure() && /\bSTARTTLS\b/i.test(greeting.text)) {
      conn.write(`STARTTLS${CRLF}`)
      await conn.read(220)
      await conn.upgrade()
      conn.write(`EHLO ${config.hostname}${CRLF}`)
      greeting = await conn.read(250)
    }

    if (input.auth) {
      const payload = Buffer.from(`\0${input.auth.user}\0${input.auth.pass}`).toString("base64")
      conn.write(`AUTH PLAIN ${payload}${CRLF}`)
      await conn.read(235)
    }

    const sizeParam = /\bSIZE\b/i.test(greeting.text) ? ` SIZE=${input.raw.length}` : ""
    conn.write(`MAIL FROM:<${input.mailFrom}>${sizeParam}${CRLF}`)
    await conn.read(250)

    conn.write(`RCPT TO:<${input.rcptTo}>${CRLF}`)
    await conn.read(250)

    conn.write(`DATA${CRLF}`)
    await conn.read(354)

    conn.write(dataPayload(input.raw))
    const accepted = await conn.read(250)

    conn.write(`QUIT${CRLF}`)
    return {
      ok: true,
      retryable: false,
      code: accepted.code,
      message: accepted.text,
      host: input.host,
    }
  } catch (e) {
    if (e instanceof SmtpFailure) {
      return {
        ok: false,
        retryable: e.retryable,
        code: e.code,
        message: e.message,
        host: input.host,
      }
    }
    // A DNS or TCP failure is transient by definition — the remote end never
    // got a chance to have an opinion.
    return {
      ok: false,
      retryable: true,
      code: 421,
      message: (e as Error).message,
      host: input.host,
    }
  } finally {
    conn?.close()
  }
}

/** MX hosts for a domain, lowest preference first. */
export const mxHostsOf = async (domain: string): Promise<string[]> => {
  try {
    const records = await resolveMx(domain)
    if (records.length) {
      return records
        .sort((a, b) => a.priority - b.priority)
        .map((r) => r.exchange.replace(/\.$/, ""))
        .filter(Boolean)
    }
  } catch {
    // Fall through to the implicit MX.
  }
  // RFC 5321 §5.1: a domain with no MX is delivered to its A record.
  return [domain]
}

/**
 * Delivers one recipient, trying each MX in preference order.
 *
 * A permanent rejection stops the walk — every MX for a domain shares the same
 * mailbox database, so a 550 from one is a 550 from all, and trying the rest
 * only multiplies the rejection in the recipient's logs.
 */
export const deliverToDomain = async (input: {
  domain: string
  mailFrom: string
  rcptTo: string
  raw: string
}): Promise<SendResult> => {
  if (config.delivery.transport === "console") {
    console.log(
      `[corsair] console transport — would deliver to ${input.rcptTo} (${input.raw.length} bytes)`,
    )
    return { ok: true, retryable: false, code: 250, message: "Console transport.", host: null }
  }

  if (config.delivery.transport === "relay") {
    const relay = config.delivery.relay
    if (!relay.host) {
      return {
        ok: false,
        retryable: false,
        code: 550,
        message: "DELIVERY_TRANSPORT is relay but SMTP_RELAY_HOST is empty.",
        host: null,
      }
    }
    return sendMessage({
      host: relay.host,
      port: relay.port,
      implicitTls: relay.secure === "tls",
      auth: relay.user ? { user: relay.user, pass: relay.pass } : undefined,
      mailFrom: input.mailFrom,
      rcptTo: input.rcptTo,
      raw: input.raw,
    })
  }

  const hosts = await mxHostsOf(input.domain)
  let last: SendResult = {
    ok: false,
    retryable: true,
    code: 421,
    message: `No MX host for ${input.domain}.`,
    host: null,
  }

  for (const host of hosts) {
    last = await sendMessage({
      host,
      mailFrom: input.mailFrom,
      rcptTo: input.rcptTo,
      raw: input.raw,
    })
    if (last.ok) return last
    if (!last.retryable) return last
  }
  return last
}
