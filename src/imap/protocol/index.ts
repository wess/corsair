/**
 * IMAP wire primitives: the tokenizer, the response encoders, sequence sets,
 * and modified UTF-7.
 *
 * Everything here works on latin1 strings for the same reason core/mime does —
 * a literal is announced with a byte count, and a UTF-8 JS string cannot tell
 * you one.
 */

const CRLF = "\r\n"

// ------------------------------------------------------- modified UTF-7 --

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+,"

/**
 * IMAP mailbox names are modified UTF-7 (RFC 3501 §5.1.3): "&" introduces a
 * base64 run with "," substituted for "/", and "&-" is a literal ampersand.
 * Without this, a folder called "Rechnungen" is fine but "Belegé" comes back as
 * mojibake in every client.
 */
export const decodeMailbox = (input: string): string => {
  let out = ""
  let i = 0
  while (i < input.length) {
    const c = input[i]!
    if (c !== "&") {
      out += c
      i++
      continue
    }
    const end = input.indexOf("-", i + 1)
    if (end === -1) {
      out += c
      i++
      continue
    }
    const chunk = input.slice(i + 1, end)
    if (chunk === "") {
      out += "&"
      i = end + 1
      continue
    }

    let bits = 0
    let value = 0
    let decoded = ""
    for (const ch of chunk) {
      const index = B64.indexOf(ch)
      if (index === -1) continue
      value = (value << 6) | index
      bits += 6
      if (bits >= 16) {
        bits -= 16
        decoded += String.fromCharCode((value >> bits) & 0xffff)
      }
    }
    out += decoded
    i = end + 1
  }
  return out
}

export const encodeMailbox = (input: string): string => {
  let out = ""
  let run = ""

  const flush = () => {
    if (!run) return
    let bits = 0
    let value = 0
    let encoded = ""
    for (const ch of run) {
      value = (value << 16) | ch.charCodeAt(0)
      bits += 16
      while (bits >= 6) {
        bits -= 6
        encoded += B64[(value >> bits) & 0x3f]
      }
    }
    if (bits > 0) encoded += B64[(value << (6 - bits)) & 0x3f]
    out += `&${encoded}-`
    run = ""
  }

  for (const ch of input) {
    const code = ch.charCodeAt(0)
    if (ch === "&") {
      flush()
      out += "&-"
    } else if (code >= 0x20 && code <= 0x7e) {
      flush()
      out += ch
    } else {
      run += ch
    }
  }
  flush()
  return out
}

// ------------------------------------------------------------- tokenizer --

export type Token =
  | { kind: "atom"; value: string }
  | { kind: "string"; value: string }
  | { kind: "literal"; value: string }
  | { kind: "nil" }
  | { kind: "list"; items: Token[] }

export type Reader = {
  eof: () => boolean
  peek: () => string
  /** Next space-delimited atom, upper-cased. */
  word: () => string
  /** Next atom, quoted string, or literal, with its original case. */
  astring: () => string
  /** Next parenthesised list, as raw text with the parentheses removed. */
  parenthesised: () => string
  number: () => number
  /** Everything left, verbatim. */
  rest: () => string
  skipSpace: () => void
  /** Position, for parsers that need to slice the source themselves. */
  index: () => number
  source: () => string
  seek: (to: number) => void
}

export const createReader = (source: string): Reader => {
  let i = 0

  const skipSpace = () => {
    while (i < source.length && source[i] === " ") i++
  }

  const readQuoted = (): string => {
    i++ // opening quote
    let out = ""
    while (i < source.length) {
      const c = source[i]!
      if (c === "\\" && i + 1 < source.length) {
        out += source[i + 1]
        i += 2
        continue
      }
      if (c === '"') {
        i++
        return out
      }
      out += c
      i++
    }
    return out
  }

  const readLiteral = (): string => {
    // {n}CRLF followed by exactly n octets. The command was assembled before it
    // got here, so the bytes are already present.
    const close = source.indexOf("}", i)
    if (close === -1) return ""
    const count = Number(source.slice(i + 1, close).replace("+", ""))
    let start = close + 1
    if (source.startsWith(CRLF, start)) start += 2
    else if (source[start] === "\n") start += 1
    const value = source.slice(start, start + count)
    i = start + count
    return value
  }

  return {
    eof: () => {
      skipSpace()
      return i >= source.length
    },
    peek: () => {
      skipSpace()
      return source[i] ?? ""
    },
    word: () => {
      skipSpace()
      const start = i
      while (i < source.length && !" ()[]{".includes(source[i]!)) i++
      return source.slice(start, i).toUpperCase()
    },
    astring: () => {
      skipSpace()
      const c = source[i]
      if (c === '"') return readQuoted()
      if (c === "{") return readLiteral()
      const start = i
      while (i < source.length && !" ()[]".includes(source[i]!)) i++
      const value = source.slice(start, i)
      return value.toUpperCase() === "NIL" ? "" : value
    },
    parenthesised: () => {
      skipSpace()
      if (source[i] !== "(") return ""
      let depth = 0
      const start = i
      let quoted = false
      while (i < source.length) {
        const c = source[i]!
        if (quoted) {
          if (c === "\\") i++
          else if (c === '"') quoted = false
        } else if (c === '"') quoted = true
        else if (c === "(") depth++
        else if (c === ")") {
          depth--
          if (depth === 0) {
            i++
            return source.slice(start + 1, i - 1)
          }
        }
        i++
      }
      return source.slice(start + 1)
    },
    number: () => {
      skipSpace()
      const start = i
      while (i < source.length && /[0-9]/.test(source[i]!)) i++
      return Number(source.slice(start, i))
    },
    rest: () => {
      skipSpace()
      const out = source.slice(i)
      i = source.length
      return out
    },
    skipSpace,
    index: () => i,
    source: () => source,
    seek: (to: number) => {
      i = to
    },
  }
}

// ---------------------------------------------------------- sequence sets --

export type SequenceSet = { start: number; end: number }[]

/**
 * Parses `1,3:5,10:*`. The `*` is the largest value in the mailbox, which the
 * caller supplies because it differs between a sequence set (message count) and
 * a UID set (highest UID).
 *
 * A reversed range like `5:3` is legal and means 3:5 — clients do emit it.
 */
export const parseSequenceSet = (input: string, max: number): SequenceSet => {
  const out: SequenceSet = []
  for (const part of input.split(",")) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(":")
    if (colon === -1) {
      const value = trimmed === "*" ? max : Number(trimmed)
      if (Number.isFinite(value)) out.push({ start: value, end: value })
      continue
    }
    const lo = trimmed.slice(0, colon)
    const hi = trimmed.slice(colon + 1)
    const a = lo === "*" ? max : Number(lo)
    const b = hi === "*" ? max : Number(hi)
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue
    out.push({ start: Math.min(a, b), end: Math.max(a, b) })
  }
  return out
}

export const inSequenceSet = (set: SequenceSet, value: number): boolean =>
  set.some((range) => value >= range.start && value <= range.end)

/** Renders a sorted list of numbers as a compact set, for EXPUNGE and COPYUID. */
export const formatSequenceSet = (values: number[]): string => {
  if (!values.length) return ""
  const sorted = [...values].sort((a, b) => a - b)
  const parts: string[] = []
  let start = sorted[0]!
  let previous = start
  for (const value of sorted.slice(1)) {
    if (value === previous + 1) {
      previous = value
      continue
    }
    parts.push(start === previous ? `${start}` : `${start}:${previous}`)
    start = value
    previous = value
  }
  parts.push(start === previous ? `${start}` : `${start}:${previous}`)
  return parts.join(",")
}

// ---------------------------------------------------------------- encode --

// biome-ignore lint/suspicious/noControlCharactersInRegex: deciding quoted-vs-literal is exactly a control-character test
const NEEDS_LITERAL = /[\r\n\x00-\x1f\x7f-\xff]/

/** A string as IMAP sees it: quoted when it can be, a literal when it cannot. */
export const encodeString = (value: string | null): string => {
  if (value === null) return "NIL"
  if (NEEDS_LITERAL.test(value)) {
    return `{${value.length}}${CRLF}${value}`
  }
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export const encodeList = (items: (string | null)[]): string =>
  items.length ? `(${items.map((i) => i ?? "NIL").join(" ")})` : "NIL"

export const encodeDate = (date: Date): string => {
  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ]
  const pad = (n: number) => String(n).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, " ")
  return `${day}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
}

/** `1-Aug-2026` and the INTERNALDATE form, both of which clients send. */
export const parseImapDate = (value: string): Date | null => {
  const match = value.match(
    /^\s*"?(\d{1,2})-([A-Za-z]{3})-(\d{4})(?:\s+(\d{2}):(\d{2}):(\d{2})\s*([+-]\d{4})?)?"?\s*$/,
  )
  if (!match) return null
  const months: Record<string, number> = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  }
  const month = months[match[2]!.toLowerCase()]
  if (month === undefined) return null

  const date = Date.UTC(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4] ?? "0"),
    Number(match[5] ?? "0"),
    Number(match[6] ?? "0"),
  )
  const zone = match[7]
  if (!zone) return new Date(date)
  const sign = zone[0] === "-" ? 1 : -1
  const offset = (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5))) * 60_000
  return new Date(date + sign * offset)
}

export const encodeFlags = (flags: string[]): string => `(${flags.join(" ")})`
