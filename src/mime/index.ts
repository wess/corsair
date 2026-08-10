/**
 * RFC 5322 / RFC 2045 parsing, done over a *latin1* string.
 *
 * Every offset and octet count IMAP reports has to be a byte count, and a UTF-8
 * JS string does not give you one — "é" is one character and two octets. Keeping
 * the message as latin1 makes one character exactly one byte, so `.length`,
 * `.slice()`, and the offsets recorded here are all in the units IMAP wants.
 * Text is decoded to real Unicode only at the point something wants to read it.
 */

export type Header = { name: string; value: string }

export type Disposition = { type: string; params: Record<string, string> }

export type Part = {
  /** Dotted IMAP part number, e.g. "1.2". Empty for the message root. */
  section: string
  type: string
  subtype: string
  params: Record<string, string>
  id: string | null
  description: string | null
  encoding: string
  disposition: Disposition | null
  headers: Header[]
  /** Byte offsets into the raw message. */
  headerStart: number
  bodyStart: number
  end: number
  size: number
  lines: number
  parts: Part[]
  /** Set for message/rfc822 parts, whose body is itself a message. */
  child: ParsedMessage | null
}

export type ParsedMessage = {
  headers: Header[]
  headerStart: number
  bodyStart: number
  end: number
  root: Part
}

const CRLF = "\r\n"

// ------------------------------------------------------------------ bytes --

export const toLatin1 = (input: Uint8Array | string): string =>
  typeof input === "string" ? input : Buffer.from(input).toString("latin1")

export const fromLatin1 = (input: string): Buffer => Buffer.from(input, "latin1")

/**
 * A bare CR or LF anywhere in a header value injects a header. Every value and
 * every header name this module emits goes through here first. There are
 * regression tests for this — keep them.
 */
export const stripControls = (value: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping controls is the point
  value.replace(/[\x00-\x1f\x7f]/g, " ").trim()

/** Messages arriving over SMTP are already CRLF; anything hand-built may not be. */
export const normalizeEol = (raw: string): string => raw.replace(/\r\n|\r|\n/g, CRLF)

// ---------------------------------------------------------------- headers --

/**
 * Splits the header block from the body and unfolds continuation lines.
 * Returns the raw headers with their byte offsets so callers can slice the
 * original for BODY[HEADER].
 */
export const splitHeaders = (
  raw: string,
  start = 0,
  end = raw.length,
): { headers: Header[]; bodyStart: number } => {
  const headers: Header[] = []
  let i = start
  let name = ""
  let value = ""

  const flush = () => {
    if (name) headers.push({ name, value: value.replace(/\r\n[ \t]+/g, " ").trim() })
    name = ""
    value = ""
  }

  while (i < end) {
    const nl = raw.indexOf(CRLF, i)
    const lineEnd = nl === -1 || nl > end ? end : nl
    const line = raw.slice(i, lineEnd)
    const next = nl === -1 ? end : nl + 2

    // The blank line ends the header block. A body may legitimately be empty,
    // in which case bodyStart lands on `end`.
    if (line === "") {
      flush()
      return { headers, bodyStart: next }
    }

    if (line[0] === " " || line[0] === "\t") {
      value += CRLF + line
    } else {
      flush()
      const colon = line.indexOf(":")
      if (colon === -1) {
        // A header line with no colon is malformed. Keeping it as a name with an
        // empty value loses nothing and avoids dropping a line the sender may
        // have intended as data.
        name = line.trim()
        value = ""
      } else {
        name = line.slice(0, colon).trim()
        value = line.slice(colon + 1)
      }
    }
    i = next
  }

  flush()
  return { headers, bodyStart: end }
}

export const headerValue = (headers: readonly Header[], name: string): string | null => {
  const lower = name.toLowerCase()
  for (const h of headers) if (h.name.toLowerCase() === lower) return h.value.trim()
  return null
}

export const headerValues = (headers: readonly Header[], name: string): string[] => {
  const lower = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value.trim())
}

// ------------------------------------------------------- encoded words --

const decodeCharset = (bytes: Buffer, charset: string): string => {
  const cs = charset.toLowerCase().replace(/[^a-z0-9-]/g, "")
  try {
    // Bun ships full ICU, so any label TextDecoder knows works here. Unknown
    // labels throw, and latin1 is the right fallback: it never fails and
    // preserves the bytes for anything that is really ASCII.
    return new TextDecoder(cs === "utf8" ? "utf-8" : cs).decode(bytes)
  } catch {
    return bytes.toString("latin1")
  }
}

const decodeQ = (input: string): Buffer => {
  const out: number[] = []
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (c === "_") out.push(0x20)
    else if (c === "=" && i + 2 < input.length) {
      const hex = input.slice(i + 1, i + 3)
      const n = Number.parseInt(hex, 16)
      if (Number.isNaN(n)) out.push(c.charCodeAt(0))
      else {
        out.push(n)
        i += 2
      }
    } else out.push(c.charCodeAt(0))
  }
  return Buffer.from(out)
}

/**
 * RFC 2047 decoding. Adjacent encoded words separated only by whitespace are
 * joined without it, which is what the spec requires and what makes a subject
 * split mid-character across two words come back intact.
 */
export const decodeWords = (input: string): string => {
  if (!input.includes("=?")) return input

  const pattern = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g
  let result = ""
  let last = 0

  // Adjacent words in the same charset have their *bytes* concatenated before
  // decoding. Mailers split a long subject on a fixed word length with no
  // regard for character boundaries, so decoding each word on its own turns a
  // multi-byte character straddling the split into two replacement characters.
  let pending: Buffer[] = []
  let pendingCharset = ""

  const flush = () => {
    if (!pending.length) return
    result += decodeCharset(Buffer.concat(pending), pendingCharset)
    pending = []
    pendingCharset = ""
  }

  for (const match of input.matchAll(pattern)) {
    const index = match.index ?? 0
    const between = input.slice(last, index)
    // Whitespace *between* two encoded words is a separator, not content.
    const isSeparator = pending.length > 0 && between.trim() === ""
    if (!isSeparator) {
      flush()
      result += between
    }

    const [, charset = "utf-8", enc = "b", payload = ""] = match
    const bytes =
      enc.toLowerCase() === "b"
        ? Buffer.from(payload.replace(/\s+/g, ""), "base64")
        : decodeQ(payload)

    if (pending.length && charset.toLowerCase() !== pendingCharset.toLowerCase()) flush()
    pendingCharset = charset
    pending.push(bytes)

    last = index + match[0].length
  }

  flush()
  return result + input.slice(last)
}

/** Encodes a header value as an RFC 2047 word when it is not plain ASCII. */
export const encodeWord = (input: string): string => {
  const clean = stripControls(input)
  if (/^[\x20-\x7e]*$/.test(clean)) return clean
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`
}

// -------------------------------------------------- parameterised headers --

/**
 * Parses `text/plain; charset="utf-8"; name=x`, including the RFC 2231
 * continuations (`name*0`, `name*1`) and charset-tagged (`name*`) forms that
 * every real mailer emits for long filenames.
 */
export const parseParams = (input: string): { value: string; params: Record<string, string> } => {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let current = ""
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!
    if (quoted) {
      if (c === "\\" && i + 1 < input.length) {
        current += input[++i]
        continue
      }
      if (c === '"') quoted = false
      else current += c
      continue
    }
    if (c === '"') {
      quoted = true
      continue
    }
    if (c === "(") depth++
    else if (c === ")") depth = Math.max(0, depth - 1)
    else if (c === ";" && depth === 0) {
      parts.push(current)
      current = ""
      continue
    }
    if (depth === 0) current += c
  }
  parts.push(current)

  const value = (parts.shift() ?? "").trim()
  const raw: Record<string, string> = {}
  for (const part of parts) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    raw[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim()
  }

  // Reassemble RFC 2231 continuations before decoding, since a multi-byte
  // character can be split across two segments.
  const continued: Record<string, string[]> = {}
  const params: Record<string, string> = {}
  for (const [key, val] of Object.entries(raw)) {
    const match = key.match(/^([^*]+)\*(\d+)\*?$/)
    if (match) {
      const [, base = "", index = "0"] = match
      if (!continued[base]) continued[base] = []
      continued[base][Number(index)] = val
      continue
    }
    params[key.replace(/\*$/, "")] = key.endsWith("*") ? decode2231(val) : val
  }
  for (const [key, segments] of Object.entries(continued)) {
    const joined = segments.filter((s) => s !== undefined).join("")
    params[key] = joined.includes("'") ? decode2231(joined) : joined
  }

  return { value, params }
}

const decode2231 = (input: string): string => {
  const first = input.indexOf("'")
  if (first === -1) return input
  const second = input.indexOf("'", first + 1)
  if (second === -1) return input
  const charset = input.slice(0, first) || "utf-8"
  const encoded = input.slice(second + 1)
  const bytes: number[] = []
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === "%" && i + 2 < encoded.length) {
      bytes.push(Number.parseInt(encoded.slice(i + 1, i + 3), 16))
      i += 2
    } else bytes.push(encoded.charCodeAt(i))
  }
  return decodeCharset(Buffer.from(bytes), charset)
}

// --------------------------------------------------------------- addresses --

export type MailAddress = { name: string | null; address: string }

/**
 * Splits an address list on commas that are not inside quotes, comments, or
 * angle brackets, then pulls the addr-spec out of each entry. Group syntax
 * (`Team: a@x, b@y;`) is flattened to its members, which is what every client
 * shows and what delivery has to do anyway.
 */
export const parseAddressList = (input: string | null): MailAddress[] => {
  if (!input) return []
  const decoded = decodeWords(input)
  const entries: string[] = []
  let current = ""
  let quoted = false
  let angle = 0
  let comment = 0

  for (let i = 0; i < decoded.length; i++) {
    const c = decoded[i]!
    if (quoted) {
      current += c
      if (c === "\\" && i + 1 < decoded.length) {
        i++
        current += decoded[i]
      } else if (c === '"') quoted = false
      continue
    }
    switch (c) {
      case '"':
        quoted = true
        current += c
        break
      case "<":
        angle++
        current += c
        break
      case ">":
        angle = Math.max(0, angle - 1)
        current += c
        break
      case "(":
        comment++
        break
      case ")":
        comment = Math.max(0, comment - 1)
        break
      case ",":
      case ";":
        if (angle === 0 && comment === 0) {
          entries.push(current)
          current = ""
        } else current += c
        break
      case ":":
        // Group name — discard it and keep the members that follow.
        if (angle === 0 && comment === 0) current = ""
        else current += c
        break
      default:
        if (comment === 0) current += c
    }
  }
  entries.push(current)

  const out: MailAddress[] = []
  for (const entry of entries) {
    const trimmed = entry.trim()
    if (!trimmed) continue
    const open = trimmed.lastIndexOf("<")
    const close = trimmed.lastIndexOf(">")
    if (open !== -1 && close > open) {
      const address = trimmed.slice(open + 1, close).trim()
      const name = trimmed.slice(0, open).trim().replace(/^"|"$/g, "").trim()
      if (address) out.push({ name: name || null, address })
    } else if (trimmed.includes("@")) {
      out.push({ name: null, address: trimmed })
    }
  }
  return out
}

export const formatAddress = (input: MailAddress): string =>
  input.name
    ? `${encodeWord(input.name)} <${stripControls(input.address)}>`
    : stripControls(input.address)

// ------------------------------------------------------------------ bodies --

export const decodeBody = (raw: string, encoding: string, charset = "utf-8"): string => {
  const bytes = decodeTransfer(raw, encoding)
  return decodeCharset(bytes, charset)
}

export const decodeTransfer = (raw: string, encoding: string): Buffer => {
  switch (encoding.toLowerCase()) {
    case "base64":
      return Buffer.from(raw.replace(/[^A-Za-z0-9+/=]/g, ""), "base64")
    case "quoted-printable":
      return decodeQuotedPrintable(raw)
    default:
      return Buffer.from(raw, "latin1")
  }
}

const decodeQuotedPrintable = (raw: string): Buffer => {
  const out: number[] = []
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (c !== "=") {
      out.push(c.charCodeAt(0) & 0xff)
      continue
    }
    // Soft line break: "=" at end of line means "no break here".
    if (raw.startsWith(CRLF, i + 1)) {
      i += 2
      continue
    }
    const hex = raw.slice(i + 1, i + 3)
    const n = Number.parseInt(hex, 16)
    if (/^[0-9a-fA-F]{2}$/.test(hex) && !Number.isNaN(n)) {
      out.push(n)
      i += 2
    } else out.push(0x3d)
  }
  return Buffer.from(out)
}

export const encodeQuotedPrintable = (input: string): string => {
  const bytes = Buffer.from(input, "utf8")
  let out = ""
  let lineLength = 0
  const push = (chunk: string) => {
    if (lineLength + chunk.length > 75) {
      out += `=${CRLF}`
      lineLength = 0
    }
    out += chunk
    lineLength += chunk.length
  }
  for (const b of bytes) {
    if (b === 0x0a) {
      out += CRLF
      lineLength = 0
    } else if (b === 0x0d) {
      // handled by the 0x0a branch
    } else if (b === 0x3d || b < 0x20 || b > 0x7e) {
      push(`=${b.toString(16).toUpperCase().padStart(2, "0")}`)
    } else push(String.fromCharCode(b))
  }
  return out
}

export const encodeBase64Lines = (input: Buffer | string, width = 76): string => {
  const b64 = (typeof input === "string" ? Buffer.from(input, "utf8") : input).toString("base64")
  const lines: string[] = []
  for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width))
  return lines.join(CRLF)
}

// ------------------------------------------------------------------ parse --

const countLines = (raw: string, start: number, end: number): number => {
  let count = 0
  let i = start
  while (i < end) {
    const nl = raw.indexOf(CRLF, i)
    if (nl === -1 || nl >= end) {
      // A trailing fragment with no terminator is still a line.
      if (end > i) count++
      break
    }
    count++
    i = nl + 2
  }
  return count
}

const findBoundaries = (raw: string, start: number, end: number, boundary: string): number[] => {
  const marker = `--${boundary}`
  const offsets: number[] = []
  let i = start
  while (i < end) {
    const at = raw.indexOf(marker, i)
    if (at === -1 || at >= end) break
    // A boundary is only a boundary at the start of a line.
    const atLineStart = at === start || raw.startsWith(CRLF, at - 2)
    if (atLineStart) offsets.push(at)
    i = at + marker.length
  }
  return offsets
}

const parsePart = (raw: string, start: number, end: number, section: string): Part => {
  const { headers, bodyStart } = splitHeaders(raw, start, end)

  const ct = parseParams(headerValue(headers, "content-type") ?? "text/plain")
  const [typeRaw = "text", subtypeRaw = "plain"] = ct.value.toLowerCase().split("/")
  const type = typeRaw.trim() || "text"
  const subtype = (subtypeRaw ?? "plain").trim() || "plain"

  const cd = headerValue(headers, "content-disposition")
  const disposition = cd
    ? (() => {
        const parsed = parseParams(cd)
        return { type: parsed.value.toLowerCase() || "attachment", params: parsed.params }
      })()
    : null

  const part: Part = {
    section,
    type,
    subtype,
    params: ct.params,
    id: headerValue(headers, "content-id"),
    description: headerValue(headers, "content-description"),
    encoding: (headerValue(headers, "content-transfer-encoding") ?? "7bit").toLowerCase(),
    disposition,
    headers,
    headerStart: start,
    bodyStart,
    end,
    size: Math.max(0, end - bodyStart),
    lines: countLines(raw, bodyStart, end),
    parts: [],
    child: null,
  }

  if (type === "multipart" && ct.params.boundary) {
    const offsets = findBoundaries(raw, bodyStart, end, ct.params.boundary)
    for (let i = 0; i < offsets.length - 1; i++) {
      const open = offsets[i]!
      const close = offsets[i + 1]!
      // Skip past the boundary line itself to reach the child's headers.
      const afterMarker = raw.indexOf(CRLF, open)
      if (afterMarker === -1 || afterMarker + 2 >= close) continue
      const childStart = afterMarker + 2
      // The CRLF before the next boundary belongs to the boundary, not the body.
      const childEnd = Math.max(childStart, close - 2)
      const childSection = section
        ? `${section}.${part.parts.length + 1}`
        : `${part.parts.length + 1}`
      part.parts.push(parsePart(raw, childStart, childEnd, childSection))
    }
  } else if (type === "message" && subtype === "rfc822") {
    part.child = parseMessageRange(raw, bodyStart, end, section)
  }

  return part
}

const parseMessageRange = (
  raw: string,
  start: number,
  end: number,
  section: string,
): ParsedMessage => {
  const root = parsePart(raw, start, end, section)
  return { headers: root.headers, headerStart: start, bodyStart: root.bodyStart, end, root }
}

/**
 * Parses a full message. `raw` must be latin1 (see the note at the top) and
 * CRLF-terminated; `normalizeEol` gets you there if it came from a file.
 */
export const parseMessage = (raw: string): ParsedMessage =>
  parseMessageRange(raw, 0, raw.length, "")

// ------------------------------------------------------------- extraction --

export const walk = (part: Part, visit: (p: Part) => void): void => {
  visit(part)
  for (const child of part.parts) walk(child, visit)
  if (part.child) walk(part.child.root, visit)
}

export const findPart = (message: ParsedMessage, section: string): Part | null => {
  let found: Part | null = null
  walk(message.root, (p) => {
    if (p.section === section) found = p
  })
  // A single-part message has no part 1; IMAP still lets a client ask for it.
  if (!found && section === "1" && message.root.parts.length === 0) return message.root
  return found
}

export const partText = (raw: string, part: Part): string =>
  decodeBody(raw.slice(part.bodyStart, part.end), part.encoding, part.params.charset ?? "utf-8")

/** The first text/plain (falling back to text/html) that is not an attachment. */
export const bodyText = (raw: string, message: ParsedMessage): { text: string; html: string } => {
  let text = ""
  let html = ""
  walk(message.root, (p) => {
    if (p.type !== "text") return
    if (p.disposition?.type === "attachment") return
    if (p.subtype === "plain" && !text) text = partText(raw, p)
    else if (p.subtype === "html" && !html) html = partText(raw, p)
  })
  return { text, html }
}

export const attachmentParts = (message: ParsedMessage): Part[] => {
  const out: Part[] = []
  walk(message.root, (p) => {
    if (p.type === "multipart") return
    if (p === message.root && p.type === "text") return
    const filename = p.disposition?.params.filename ?? p.params.name
    if (p.disposition?.type === "attachment" || filename) out.push(p)
  })
  return out
}

const stripHtml = (input: string): string =>
  input
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")

export const snippetOf = (raw: string, message: ParsedMessage, length = 240): string => {
  const { text, html } = bodyText(raw, message)
  const source = text || stripHtml(html)
  return source.replace(/\s+/g, " ").trim().slice(0, length)
}

/**
 * What IMAP SEARCH TEXT and the panel's search box match against: every header
 * a human would search plus the decoded text of every non-attachment part.
 */
export const searchTextOf = (raw: string, message: ParsedMessage, limit = 100_000): string => {
  const chunks: string[] = []
  for (const name of ["subject", "from", "to", "cc", "bcc", "reply-to"]) {
    const v = headerValue(message.headers, name)
    if (v) chunks.push(decodeWords(v))
  }
  const { text, html } = bodyText(raw, message)
  chunks.push(text || stripHtml(html))
  return chunks.join(" ").replace(/\s+/g, " ").trim().slice(0, limit)
}

// ---------------------------------------------------------------- envelope --

export type Envelope = {
  date: string | null
  subject: string | null
  from: string[]
  sender: string[]
  reply_to: string[]
  to: string[]
  cc: string[]
  bcc: string[]
  in_reply_to: string | null
  message_id: string | null
}

const addressStrings = (headers: readonly Header[], name: string): string[] =>
  parseAddressList(headerValue(headers, name)).map((a) =>
    a.name ? `${a.name} <${a.address}>` : a.address,
  )

export const envelopeOf = (message: ParsedMessage): Envelope => {
  const h = message.headers
  const from = addressStrings(h, "from")
  return {
    date: headerValue(h, "date"),
    subject: decodeWords(headerValue(h, "subject") ?? "") || null,
    from,
    // RFC 3501: sender and reply-to default to from when absent.
    sender: addressStrings(h, "sender").length ? addressStrings(h, "sender") : from,
    reply_to: addressStrings(h, "reply-to").length ? addressStrings(h, "reply-to") : from,
    to: addressStrings(h, "to"),
    cc: addressStrings(h, "cc"),
    bcc: addressStrings(h, "bcc"),
    in_reply_to: headerValue(h, "in-reply-to"),
    message_id: headerValue(h, "message-id"),
  }
}

// ------------------------------------------------------------------ build --

export type BuildInput = {
  from: MailAddress
  to: MailAddress[]
  cc?: MailAddress[]
  subject: string
  text?: string
  html?: string
  messageId: string
  date?: Date
  inReplyTo?: string | null
  references?: string[]
  headers?: Record<string, string>
  attachments?: { filename: string; contentType: string; content: Buffer }[]
}

const boundary = (): string =>
  `--=_corsair_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`

/**
 * Builds a message. Used for bounces, account notifications, and the panel's
 * own outgoing mail — not for anything a customer composes, which arrives over
 * submission already formed.
 */
export const buildMessage = (input: BuildInput): string => {
  const lines: string[] = []
  const header = (name: string, value: string) =>
    lines.push(`${stripControls(name)}: ${stripControls(value)}`)

  header("Date", (input.date ?? new Date()).toUTCString())
  header("From", formatAddress(input.from))
  header("To", input.to.map(formatAddress).join(", "))
  if (input.cc?.length) header("Cc", input.cc.map(formatAddress).join(", "))
  header("Subject", encodeWord(input.subject))
  header("Message-ID", input.messageId)
  if (input.inReplyTo) header("In-Reply-To", input.inReplyTo)
  if (input.references?.length) header("References", input.references.join(" "))
  for (const [k, v] of Object.entries(input.headers ?? {})) header(k, v)
  header("MIME-Version", "1.0")

  const attachments = input.attachments ?? []
  const hasAlternative = Boolean(input.text && input.html)

  const textPart = (): string[] => [
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(input.text ?? ""),
  ]
  const htmlPart = (): string[] => [
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    encodeQuotedPrintable(input.html ?? ""),
  ]

  const body: string[] = []
  const alt = boundary()
  const mixed = boundary()

  const inner = (): string[] => {
    if (hasAlternative) {
      return [
        `Content-Type: multipart/alternative; boundary="${alt}"`,
        "",
        `--${alt}`,
        ...textPart(),
        `--${alt}`,
        ...htmlPart(),
        `--${alt}--`,
      ]
    }
    return input.html ? htmlPart() : textPart()
  }

  if (attachments.length === 0) {
    body.push(...inner())
  } else {
    body.push(`Content-Type: multipart/mixed; boundary="${mixed}"`, "", `--${mixed}`, ...inner())
    for (const att of attachments) {
      body.push(
        `--${mixed}`,
        `Content-Type: ${stripControls(att.contentType)}; name="${stripControls(att.filename)}"`,
        `Content-Disposition: attachment; filename="${stripControls(att.filename)}"`,
        "Content-Transfer-Encoding: base64",
        "",
        encodeBase64Lines(att.content),
      )
    }
    body.push(`--${mixed}--`)
  }

  return `${[...lines, ...body].join(CRLF)}${CRLF}`
}
