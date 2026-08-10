import { num } from "../../db/index.ts"
import * as mime from "../../mime/index.ts"
import type { Message } from "../../schema/index.ts"
import { createReader, inSequenceSet, parseImapDate, parseSequenceSet } from "../protocol/index.ts"

/**
 * SEARCH.
 *
 * Criteria are parsed into a tree and evaluated over the folder's messages.
 * Most terms answer from the row — flags, size, dates, and the denormalised
 * subject/from/search_text columns — so the common searches never touch the
 * body store. Only HEADER on an arbitrary field needs the original bytes, and
 * that is loaded lazily and only for the messages still in the running.
 */

export type Criterion =
  | { kind: "all" }
  | { kind: "and"; children: Criterion[] }
  | { kind: "or"; children: [Criterion, Criterion] }
  | { kind: "not"; child: Criterion }
  | { kind: "flag"; flag: string; present: boolean }
  | {
      kind: "text"
      field: "subject" | "from" | "to" | "cc" | "bcc" | "body" | "text"
      value: string
    }
  | { kind: "header"; field: string; value: string }
  | { kind: "date"; op: "before" | "on" | "since"; value: Date; sent: boolean }
  | { kind: "size"; op: "larger" | "smaller"; value: number }
  | { kind: "sequence"; set: string; uid: boolean }
  | { kind: "modseq"; value: bigint }

export type ParsedSearch = { criterion: Criterion; needsHeaders: boolean }

const FLAG_TERMS: Record<string, { flag: string; present: boolean }> = {
  ANSWERED: { flag: "\\Answered", present: true },
  UNANSWERED: { flag: "\\Answered", present: false },
  DELETED: { flag: "\\Deleted", present: true },
  UNDELETED: { flag: "\\Deleted", present: false },
  DRAFT: { flag: "\\Draft", present: true },
  UNDRAFT: { flag: "\\Draft", present: false },
  FLAGGED: { flag: "\\Flagged", present: true },
  UNFLAGGED: { flag: "\\Flagged", present: false },
  SEEN: { flag: "\\Seen", present: true },
  UNSEEN: { flag: "\\Seen", present: false },
  RECENT: { flag: "\\Recent", present: true },
  OLD: { flag: "\\Recent", present: false },
}

export const parseSearch = (input: string): ParsedSearch => {
  const reader = createReader(input)
  let needsHeaders = false

  const parseOne = (): Criterion => {
    const token = reader.peek()
    if (token === "(") {
      const inner = reader.parenthesised()
      const nested = parseSearch(inner)
      needsHeaders = needsHeaders || nested.needsHeaders
      return nested.criterion
    }

    const word = reader.word()

    const flag = FLAG_TERMS[word]
    if (flag) return { kind: "flag", ...flag }

    switch (word) {
      case "ALL":
        return { kind: "all" }
      case "NEW":
        // NEW is RECENT and not SEEN.
        return {
          kind: "and",
          children: [
            { kind: "flag", flag: "\\Recent", present: true },
            { kind: "flag", flag: "\\Seen", present: false },
          ],
        }
      case "NOT":
        return { kind: "not", child: parseOne() }
      case "OR": {
        const left = parseOne()
        const right = parseOne()
        return { kind: "or", children: [left, right] }
      }
      case "KEYWORD":
        return { kind: "flag", flag: reader.astring(), present: true }
      case "UNKEYWORD":
        return { kind: "flag", flag: reader.astring(), present: false }

      case "SUBJECT":
      case "FROM":
      case "TO":
      case "CC":
      case "BCC":
      case "BODY":
      case "TEXT":
        return {
          kind: "text",
          field: word.toLowerCase() as "subject",
          value: reader.astring(),
        }

      case "HEADER": {
        needsHeaders = true
        const field = reader.astring()
        return { kind: "header", field, value: reader.astring() }
      }

      case "BEFORE":
      case "ON":
      case "SINCE":
      case "SENTBEFORE":
      case "SENTON":
      case "SENTSINCE": {
        const sent = word.startsWith("SENT")
        if (sent) needsHeaders = true
        const op = word.replace("SENT", "").toLowerCase() as "before"
        const value = parseImapDate(reader.astring()) ?? new Date(0)
        return { kind: "date", op, value, sent }
      }

      case "LARGER":
      case "SMALLER":
        return { kind: "size", op: word.toLowerCase() as "larger", value: reader.number() }

      case "UID":
        return { kind: "sequence", set: reader.astring(), uid: true }

      case "MODSEQ":
        return { kind: "modseq", value: BigInt(reader.astring() || "0") }

      case "CHARSET":
        // Consume the charset name and carry on; the store is already Unicode.
        reader.astring()
        return parseOne()

      case "":
        return { kind: "all" }

      default:
        // A bare sequence set, the only remaining possibility.
        if (/^[\d,:*]+$/.test(word)) return { kind: "sequence", set: word, uid: false }
        return { kind: "all" }
    }
  }

  const children: Criterion[] = []
  while (!reader.eof()) children.push(parseOne())

  const criterion: Criterion =
    children.length === 0
      ? { kind: "all" }
      : children.length === 1
        ? children[0]!
        : { kind: "and", children }

  return { criterion, needsHeaders }
}

export const needsHeaders = (criterion: Criterion): boolean => {
  switch (criterion.kind) {
    case "header":
      return true
    case "date":
      return criterion.sent
    case "and":
      return criterion.children.some(needsHeaders)
    case "or":
      return criterion.children.some(needsHeaders)
    case "not":
      return needsHeaders(criterion.child)
    default:
      return false
  }
}

// -------------------------------------------------------------- evaluate --

export type Candidate = {
  message: Message
  sequence: number
  /** Populated only when a criterion needs the original headers. */
  headers?: readonly mime.Header[]
}

const contains = (haystack: string | null | undefined, needle: string): boolean =>
  !needle || (haystack ?? "").toLowerCase().includes(needle.toLowerCase())

const sameDay = (a: Date, b: Date): boolean =>
  a.getUTCFullYear() === b.getUTCFullYear() &&
  a.getUTCMonth() === b.getUTCMonth() &&
  a.getUTCDate() === b.getUTCDate()

const dateOf = (candidate: Candidate, sent: boolean): Date => {
  if (!sent) return candidate.message.internal_date
  const header = candidate.headers ? mime.headerValue(candidate.headers, "date") : null
  const parsed = header ? new Date(header) : null
  // A malformed or missing Date header falls back to when we received it, which
  // is the only other timestamp that exists.
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : candidate.message.internal_date
}

export const matches = (
  criterion: Criterion,
  candidate: Candidate,
  ctx: { maxSequence: number; maxUid: number },
): boolean => {
  const message = candidate.message

  switch (criterion.kind) {
    case "all":
      return true

    case "and":
      return criterion.children.every((c) => matches(c, candidate, ctx))

    case "or":
      return criterion.children.some((c) => matches(c, candidate, ctx))

    case "not":
      return !matches(criterion.child, candidate, ctx)

    case "flag": {
      const present = (message.flags ?? []).some(
        (f) => f.toLowerCase() === criterion.flag.toLowerCase(),
      )
      return present === criterion.present
    }

    case "text":
      switch (criterion.field) {
        case "subject":
          return contains(message.subject, criterion.value)
        case "from":
          return contains(message.from_address, criterion.value)
        case "to":
          return contains((message.to_addresses ?? []).join(" "), criterion.value)
        case "cc":
          return contains((message.cc_addresses ?? []).join(" "), criterion.value)
        case "bcc":
          // Bcc is stripped in transit by definition, so there is nothing to
          // match. Answering "no" beats pretending the field exists.
          return false
        default:
          // BODY and TEXT both fall to the indexed extract, which holds the
          // decoded body plus the searchable headers.
          return contains(message.search_text, criterion.value)
      }

    case "header": {
      if (!candidate.headers) return false
      const values = mime.headerValues(candidate.headers, criterion.field)
      if (!criterion.value) return values.length > 0
      return values.some((v) => contains(mime.decodeWords(v), criterion.value))
    }

    case "date": {
      const value = dateOf(candidate, criterion.sent)
      if (criterion.op === "on") return sameDay(value, criterion.value)
      // BEFORE and SINCE compare whole days, not instants: a message received at
      // 23:00 is "on" that day regardless of the search's time-of-day.
      const day = Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
      const target = Date.UTC(
        criterion.value.getUTCFullYear(),
        criterion.value.getUTCMonth(),
        criterion.value.getUTCDate(),
      )
      return criterion.op === "before" ? day < target : day >= target
    }

    case "size":
      return criterion.op === "larger"
        ? message.size > criterion.value
        : message.size < criterion.value

    case "sequence": {
      const max = criterion.uid ? ctx.maxUid : ctx.maxSequence
      const set = parseSequenceSet(criterion.set, max)
      return inSequenceSet(set, criterion.uid ? num(message.uid) : candidate.sequence)
    }

    case "modseq":
      return message.modseq >= criterion.value
  }
}

// ------------------------------------------------------------------ sort --

export type SortKey = "ARRIVAL" | "CC" | "DATE" | "FROM" | "SIZE" | "SUBJECT" | "TO" | "REVERSE"

/** RFC 5256 SORT: a list of keys, each optionally preceded by REVERSE. */
export const parseSortKeys = (input: string): { key: SortKey; reverse: boolean }[] => {
  const tokens = input
    .replace(/[()]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.toUpperCase())

  const out: { key: SortKey; reverse: boolean }[] = []
  let reverse = false
  for (const token of tokens) {
    if (token === "REVERSE") {
      reverse = true
      continue
    }
    out.push({ key: token as SortKey, reverse })
    reverse = false
  }
  return out
}

const sortValue = (candidate: Candidate, key: SortKey): string | number => {
  const m = candidate.message
  switch (key) {
    case "ARRIVAL":
      return m.internal_date.getTime()
    case "DATE":
      return dateOf(candidate, true).getTime()
    case "SIZE":
      return m.size
    case "FROM":
      return (m.from_address ?? "").toLowerCase()
    case "TO":
      return (m.to_addresses ?? [])[0]?.toLowerCase() ?? ""
    case "CC":
      return (m.cc_addresses ?? [])[0]?.toLowerCase() ?? ""
    case "SUBJECT":
      // RFC 5256 sorts on the base subject, with the Re:/Fwd: prefixes removed.
      return (m.subject ?? "")
        .replace(/^\s*(re|fwd?|aw|sv)\s*(\[\d+\])?\s*:\s*/gi, "")
        .trim()
        .toLowerCase()
    default:
      return 0
  }
}

export const sortCandidates = (
  candidates: Candidate[],
  keys: { key: SortKey; reverse: boolean }[],
): Candidate[] =>
  [...candidates].sort((a, b) => {
    for (const { key, reverse } of keys) {
      const left = sortValue(a, key)
      const right = sortValue(b, key)
      if (left === right) continue
      const order = left < right ? -1 : 1
      return reverse ? -order : order
    }
    // Ties break on sequence, so the order is stable and reproducible.
    return a.sequence - b.sequence
  })
