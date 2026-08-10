import { num } from "../../db/index.ts"
import * as mime from "../../mime/index.ts"
import type { Message } from "../../schema/index.ts"
import { getRaw } from "../../storage/index.ts"
import { encodeDate, encodeString } from "../protocol/index.ts"

/**
 * Rendering for FETCH.
 *
 * The awkward part of IMAP is that FETCH is not one response shape but a dozen,
 * several of which (BODYSTRUCTURE, BODY[2.1.MIME]) require the original bytes
 * to answer at all. Items are therefore split into those that can be served
 * from the row and those that need the body, and the body is read at most once
 * per message no matter how many items ask for it.
 */

export type FetchItem = {
  /** As written by the client, echoed back verbatim in the response. */
  name: string
  kind:
    | "flags"
    | "uid"
    | "internaldate"
    | "size"
    | "envelope"
    | "body"
    | "bodystructure"
    | "section"
    | "rfc822"
    | "rfc822.header"
    | "rfc822.text"
    | "modseq"
  section?: string
  partial?: { offset: number; length: number }
  /** BODY.PEEK[...] does not set \Seen; BODY[...] does. */
  peek?: boolean
}

const MACROS: Record<string, string> = {
  ALL: "FLAGS INTERNALDATE RFC822.SIZE ENVELOPE",
  FAST: "FLAGS INTERNALDATE RFC822.SIZE",
  FULL: "FLAGS INTERNALDATE RFC822.SIZE ENVELOPE BODY",
}

/**
 * Splits a FETCH item list.
 *
 * Written by hand rather than with the generic tokenizer because the item
 * grammar nests brackets inside a parenthesised list — `BODY[HEADER.FIELDS (TO
 * FROM)]<0.100>` — and a tokenizer that treats "(" as a list opener gets that
 * wrong in a way that is worse than an explicit scanner.
 */
export const parseFetchItems = (input: string): FetchItem[] => {
  let source = input.trim()
  const macro = MACROS[source.toUpperCase()]
  if (macro) source = macro
  if (source.startsWith("(") && source.endsWith(")")) source = source.slice(1, -1)

  const items: FetchItem[] = []
  let i = 0

  while (i < source.length) {
    while (i < source.length && (source[i] === " " || source[i] === ")")) i++
    if (i >= source.length) break

    const start = i
    let depth = 0
    while (i < source.length) {
      const c = source[i]!
      if (c === "[" || c === "<") depth++
      else if (c === "]" || c === ">") depth--
      else if (c === " " && depth <= 0) break
      i++
    }
    const raw = source.slice(start, i)
    if (raw) items.push(parseItem(raw))
  }

  return items
}

const parseItem = (raw: string): FetchItem => {
  const upper = raw.toUpperCase()

  const bracket = raw.indexOf("[")
  if (bracket !== -1) {
    const close = raw.lastIndexOf("]")
    const head = upper.slice(0, bracket)
    const section = raw.slice(bracket + 1, close === -1 ? raw.length : close)
    const tail = close === -1 ? "" : raw.slice(close + 1)

    let partial: FetchItem["partial"]
    const angle = tail.match(/^<(\d+)\.(\d+)>$/)
    if (angle) partial = { offset: Number(angle[1]), length: Number(angle[2]) }

    return {
      // The response echoes the item without ".PEEK", per RFC 3501 §7.4.2.
      name: `${head.replace(".PEEK", "")}[${section}]${partial ? `<${partial.offset}>` : ""}`,
      kind: "section",
      section: section.toUpperCase(),
      partial,
      peek: head.includes(".PEEK"),
    }
  }

  switch (upper) {
    case "FLAGS":
      return { name: "FLAGS", kind: "flags" }
    case "UID":
      return { name: "UID", kind: "uid" }
    case "INTERNALDATE":
      return { name: "INTERNALDATE", kind: "internaldate" }
    case "RFC822.SIZE":
      return { name: "RFC822.SIZE", kind: "size" }
    case "ENVELOPE":
      return { name: "ENVELOPE", kind: "envelope" }
    case "BODY":
      return { name: "BODY", kind: "body" }
    case "BODYSTRUCTURE":
      return { name: "BODYSTRUCTURE", kind: "bodystructure" }
    case "RFC822":
      return { name: "RFC822", kind: "rfc822" }
    case "RFC822.HEADER":
      return { name: "RFC822.HEADER", kind: "rfc822.header" }
    case "RFC822.TEXT":
      return { name: "RFC822.TEXT", kind: "rfc822.text" }
    case "MODSEQ":
      return { name: "MODSEQ", kind: "modseq" }
    default:
      return { name: upper, kind: "flags" }
  }
}

// ENVELOPE belongs here too: it is rendered from the message's own headers, so
// answering it requires the original bytes exactly as BODYSTRUCTURE does.
export const needsBody = (items: FetchItem[]): boolean =>
  items.some((i) =>
    [
      "envelope",
      "body",
      "bodystructure",
      "section",
      "rfc822",
      "rfc822.header",
      "rfc822.text",
    ].includes(i.kind),
  )

export const setsSeen = (items: FetchItem[]): boolean =>
  items.some(
    (i) => (i.kind === "section" && !i.peek) || i.kind === "rfc822" || i.kind === "rfc822.text",
  )

// -------------------------------------------------------------- envelope --

const addressStruct = (value: string | null): string => {
  const parsed = mime.parseAddressList(value)
  if (!parsed.length) return "NIL"
  return `(${parsed
    .map((a) => {
      const at = a.address.lastIndexOf("@")
      const mailbox = at === -1 ? a.address : a.address.slice(0, at)
      const host = at === -1 ? null : a.address.slice(at + 1)
      // (display-name at-domain-list mailbox host) — the second field is the
      // obsolete source route and is always NIL.
      return `(${encodeString(a.name)} NIL ${encodeString(mailbox)} ${encodeString(host)})`
    })
    .join("")})`
}

export const renderEnvelope = (headers: readonly mime.Header[]): string => {
  const value = (name: string) => mime.headerValue(headers, name)
  const from = value("from")

  return [
    encodeString(value("date")),
    encodeString(value("subject") ? mime.decodeWords(value("subject")!) : null),
    addressStruct(from),
    // sender and reply-to fall back to from when absent (RFC 3501 §7.4.2).
    addressStruct(value("sender") ?? from),
    addressStruct(value("reply-to") ?? from),
    addressStruct(value("to")),
    addressStruct(value("cc")),
    addressStruct(value("bcc")),
    encodeString(value("in-reply-to")),
    encodeString(value("message-id")),
  ].join(" ")
}

// --------------------------------------------------------- bodystructure --

const paramList = (params: Record<string, string>): string => {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined)
  if (!entries.length) return "NIL"
  return `(${entries.map(([k, v]) => `${encodeString(k.toUpperCase())} ${encodeString(v)}`).join(" ")})`
}

const dispositionOf = (part: mime.Part): string => {
  if (!part.disposition) return "NIL"
  return `(${encodeString(part.disposition.type.toUpperCase())} ${paramList(part.disposition.params)})`
}

/**
 * `extensible` adds the fields BODYSTRUCTURE carries and BODY does not. Clients
 * do notice the difference — Apple Mail asks for BODYSTRUCTURE and uses the
 * disposition to decide what to show as an attachment.
 */
export const renderBodyStructure = (part: mime.Part, extensible: boolean): string => {
  if (part.type === "multipart") {
    const children = part.parts.map((child) => renderBodyStructure(child, extensible)).join("")
    const head = `${children} ${encodeString(part.subtype.toUpperCase())}`
    if (!extensible) return `(${head})`
    return `(${head} ${paramList(part.params)} ${dispositionOf(part)} NIL NIL)`
  }

  const base = [
    encodeString(part.type.toUpperCase()),
    encodeString(part.subtype.toUpperCase()),
    paramList(part.params),
    encodeString(part.id),
    encodeString(part.description),
    encodeString(part.encoding.toUpperCase()),
    String(part.size),
  ]

  if (part.type === "text") base.push(String(part.lines))
  if (part.type === "message" && part.subtype === "rfc822" && part.child) {
    base.push(`(${renderEnvelope(part.child.headers)})`)
    base.push(renderBodyStructure(part.child.root, extensible))
    base.push(String(part.lines))
  }

  if (extensible) {
    base.push("NIL") // body MD5
    base.push(dispositionOf(part))
    base.push("NIL") // language
    base.push("NIL") // location
  }

  return `(${base.join(" ")})`
}

// --------------------------------------------------------------- sections --

const headerSubset = (message: mime.ParsedMessage, names: string[], exclude: boolean): string => {
  const wanted = new Set(names.map((n) => n.toLowerCase()))
  const out: string[] = []
  for (const header of message.headers) {
    const match = wanted.has(header.name.toLowerCase())
    if (exclude ? match : !match) continue
    out.push(`${header.name}: ${header.value}`)
  }
  // The blank line is part of the section: clients that concatenate
  // BODY[HEADER.FIELDS] with BODY[TEXT] rely on it.
  return out.length ? `${out.join("\r\n")}\r\n\r\n` : "\r\n"
}

/** Resolves a section specifier to the bytes it names, or null if there is none. */
export const sectionBytes = (
  raw: string,
  message: mime.ParsedMessage,
  section: string,
): string | null => {
  const spec = section.trim().toUpperCase()

  if (spec === "") return raw
  if (spec === "HEADER") return raw.slice(message.headerStart, message.bodyStart)
  if (spec === "TEXT") return raw.slice(message.bodyStart, message.end)

  const fields = spec.match(/^(?:([\d.]+)\.)?HEADER\.FIELDS(\.NOT)?\s*\(([^)]*)\)$/)
  if (fields) {
    const [, prefix, not, list = ""] = fields
    const names = list.split(/\s+/).filter(Boolean)
    const target = prefix ? mime.findPart(message, prefix) : null
    if (prefix && !target) return null
    const scope: mime.ParsedMessage = prefix
      ? (target!.child ?? {
          headers: target!.headers,
          headerStart: target!.headerStart,
          bodyStart: target!.bodyStart,
          end: target!.end,
          root: target!,
        })
      : message
    return headerSubset(scope, names, Boolean(not))
  }

  const mimePart = spec.match(/^([\d.]+)\.MIME$/)
  if (mimePart) {
    const part = mime.findPart(message, mimePart[1]!)
    return part ? raw.slice(part.headerStart, part.bodyStart) : null
  }

  const nested = spec.match(/^([\d.]+)\.(HEADER|TEXT)$/)
  if (nested) {
    const part = mime.findPart(message, nested[1]!)
    if (!part?.child) return null
    return nested[2] === "HEADER"
      ? raw.slice(part.child.headerStart, part.child.bodyStart)
      : raw.slice(part.child.bodyStart, part.child.end)
  }

  if (/^[\d.]+$/.test(spec)) {
    const part = mime.findPart(message, spec)
    return part ? raw.slice(part.bodyStart, part.end) : null
  }

  return null
}

// ---------------------------------------------------------------- render --

export type RenderContext = {
  sequence: number
  message: Message
  raw: string | null
}

export const loadRaw = (message: Message): Promise<string | null> =>
  getRaw({ storageKey: message.storage_key, messageId: message.id })

const literal = (value: string): string => `{${value.length}}\r\n${value}`

export const renderFetch = (ctx: RenderContext, items: FetchItem[]): string => {
  const parsed = ctx.raw ? mime.parseMessage(ctx.raw) : null
  const parts: string[] = []

  for (const item of items) {
    switch (item.kind) {
      case "flags":
        parts.push(`FLAGS (${(ctx.message.flags ?? []).join(" ")})`)
        break
      case "uid":
        parts.push(`UID ${num(ctx.message.uid)}`)
        break
      case "internaldate":
        parts.push(`INTERNALDATE "${encodeDate(ctx.message.internal_date)}"`)
        break
      case "size":
        parts.push(`RFC822.SIZE ${ctx.message.size}`)
        break
      case "modseq":
        parts.push(`MODSEQ (${num(ctx.message.modseq)})`)
        break

      case "envelope":
        if (parsed) parts.push(`ENVELOPE (${renderEnvelope(parsed.headers)})`)
        break

      case "body":
        if (parsed) parts.push(`BODY ${renderBodyStructure(parsed.root, false)}`)
        break

      case "bodystructure":
        if (parsed) parts.push(`BODYSTRUCTURE ${renderBodyStructure(parsed.root, true)}`)
        break

      case "rfc822":
        if (ctx.raw) parts.push(`RFC822 ${literal(ctx.raw)}`)
        break

      case "rfc822.header":
        if (ctx.raw && parsed) {
          parts.push(`RFC822.HEADER ${literal(ctx.raw.slice(0, parsed.bodyStart))}`)
        }
        break

      case "rfc822.text":
        if (ctx.raw && parsed) {
          parts.push(`RFC822.TEXT ${literal(ctx.raw.slice(parsed.bodyStart))}`)
        }
        break

      case "section": {
        if (!ctx.raw || !parsed) break
        const bytes = sectionBytes(ctx.raw, parsed, item.section ?? "")
        if (bytes === null) {
          parts.push(`${item.name} NIL`)
          break
        }
        if (item.partial) {
          const slice = bytes.slice(item.partial.offset, item.partial.offset + item.partial.length)
          // An offset past the end is not an error: the client gets an empty
          // literal, which is how it discovers the length.
          parts.push(`${item.name} ${literal(slice)}`)
          break
        }
        parts.push(`${item.name} ${literal(bytes)}`)
        break
      }
    }
  }

  return `* ${ctx.sequence} FETCH (${parts.join(" ")})\r\n`
}
