import { from } from "@atlas/db"
import { authenticateAddress, type MailIdentity } from "../../auth/index.ts"
import { config } from "../../config/index.ts"
import { db, num } from "../../db/index.ts"
import { uidValidity } from "../../ids/index.ts"
import * as mime from "../../mime/index.ts"
import { type Folder, folders, type Message, messages } from "../../schema/index.ts"
import {
  bumpModseq,
  copyTo,
  deliver,
  expunge,
  folderStatus,
  messagesIn,
  setFlags,
} from "../../store/index.ts"
import { loadRaw, needsBody, parseFetchItems, renderFetch, setsSeen } from "../fetch/index.ts"
import {
  createReader,
  decodeMailbox,
  encodeMailbox,
  formatSequenceSet,
  inSequenceSet,
  parseImapDate,
  parseSequenceSet,
} from "../protocol/index.ts"
import {
  type Candidate,
  matches,
  parseSearch,
  parseSortKeys,
  needsHeaders as searchNeedsHeaders,
  sortCandidates,
} from "../search/index.ts"

const CRLF = "\r\n"

const CAPABILITIES = [
  "IMAP4rev1",
  "LITERAL+",
  "SASL-IR",
  "UIDPLUS",
  "MOVE",
  "ID",
  "UNSELECT",
  "CHILDREN",
  "NAMESPACE",
  "IDLE",
  "SORT",
  "ENABLE",
  "SPECIAL-USE",
  "LIST-EXTENDED",
  "WITHIN",
]

export type ImapHooks = {
  isSecure: () => boolean
  startTls?: () => void
  remoteIp: string
  onAuthSuccess?: () => void
  onAuthFailure?: (username: string) => void
  /** Pushes an unsolicited response, used by IDLE. */
  push: (data: string) => void
}

export type ImapSession = {
  greeting: () => string
  feed: (chunk: Uint8Array | string) => Promise<string>
  shouldClose: () => boolean
  resetAfterTls: () => void
  /** Called on a timer while the client is idling. */
  poll: () => Promise<string>
  isIdling: () => boolean
  close: () => void
}

type Selected = {
  folder: Folder
  readOnly: boolean
  /** Live messages in UID order — the array IMAP sequence numbers index into. */
  snapshot: Message[]
}

export const createImapSession = (hooks: ImapHooks): ImapSession => {
  let buffer = ""
  let command = ""
  let awaitingLiteral = 0
  let closing = false
  let identity: MailIdentity | null = null
  let selected: Selected | null = null
  let idleTag: string | null = null
  let authState: { mechanism: "plain" | "login"; tag: string; username?: string } | null = null

  const capabilityLine = (): string => {
    const caps = [...CAPABILITIES]
    if (hooks.startTls && !hooks.isSecure()) caps.push("STARTTLS")
    if (!identity && !hooks.isSecure()) caps.push("LOGINDISABLED")
    else if (!identity) caps.push("AUTH=PLAIN", "AUTH=LOGIN")
    return `* CAPABILITY ${caps.join(" ")}${CRLF}`
  }

  const ok = (tag: string, message: string, code?: string) =>
    `${tag} OK ${code ? `[${code}] ` : ""}${message}${CRLF}`
  const no = (tag: string, message: string, code?: string) =>
    `${tag} NO ${code ? `[${code}] ` : ""}${message}${CRLF}`
  const bad = (tag: string, message: string) => `${tag} BAD ${message}${CRLF}`

  // ------------------------------------------------------------- snapshot --

  /**
   * Reconciles the session's view with the database and returns the untagged
   * responses that describe the difference.
   *
   * EXPUNGE is emitted highest sequence first. IMAP renumbers after every
   * single EXPUNGE, so a client applying them in ascending order against its
   * own list removes the wrong messages — this is the classic way a webmail
   * ends up showing somebody else's mail against the wrong subject.
   */
  const sync = async (): Promise<string> => {
    if (!selected) return ""
    const current = await messagesIn(selected.folder.id)
    const live = new Set(current.map((m) => m.id))

    let out = ""
    const kept: Message[] = []
    const removals: number[] = []

    selected.snapshot.forEach((message, index) => {
      if (live.has(message.id)) kept.push(message)
      else removals.push(index + 1)
    })

    for (const sequence of removals.sort((a, b) => b - a)) {
      out += `* ${sequence} EXPUNGE${CRLF}`
    }

    const known = new Set(kept.map((m) => m.id))
    const added = current.filter((m) => !known.has(m.id))
    const next = [...kept, ...added].sort((a, b) => num(a.uid) - num(b.uid))

    // Flag changes on messages the client already knows about.
    const before = new Map(selected.snapshot.map((m) => [m.id, JSON.stringify(m.flags ?? [])]))
    next.forEach((message, index) => {
      const previous = before.get(message.id)
      const now = JSON.stringify(message.flags ?? [])
      if (previous !== undefined && previous !== now) {
        out += `* ${index + 1} FETCH (UID ${num(message.uid)} FLAGS (${(message.flags ?? []).join(" ")}))${CRLF}`
      }
    })

    if (added.length || removals.length) {
      out += `* ${next.length} EXISTS${CRLF}`
      out += `* ${added.length} RECENT${CRLF}`
    }

    selected.snapshot = next
    return out
  }

  const reload = async (folder: Folder): Promise<Folder> =>
    (await db().one<Folder>(from(folders).where((q) => q("id").equals(folder.id)))) ?? folder

  // -------------------------------------------------------------- folders --

  const folderByName = async (name: string): Promise<Folder | null> => {
    if (!identity) return null
    const decoded = decodeMailbox(name)
    // INBOX is case-insensitive by specification; every other name is not.
    const wanted = decoded.toUpperCase() === "INBOX" ? "INBOX" : decoded
    return db().one<Folder>(
      from(folders).where((q) => [
        q("address_id").equals(identity!.address.id),
        q("name").equals(wanted),
      ]),
    )
  }

  const allFolders = async (): Promise<Folder[]> =>
    identity
      ? db().all<Folder>(
          from(folders)
            .where((q) => q("address_id").equals(identity!.address.id))
            .orderBy("name", "ASC"),
        )
      : []

  const SPECIAL_USE_ATTR: Record<string, string> = {
    inbox: "\\Inbox",
    sent: "\\Sent",
    drafts: "\\Drafts",
    trash: "\\Trash",
    junk: "\\Junk",
    archive: "\\Archive",
  }

  /** Converts an IMAP wildcard pattern (`%` one level, `*` any) to a regex. */
  const patternToRegex = (pattern: string): RegExp => {
    let out = ""
    for (const ch of pattern) {
      if (ch === "*") out += "[\\s\\S]*"
      else if (ch === "%") out += "[^/]*"
      else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    }
    return new RegExp(`^${out}$`, "i")
  }

  const listResponse = async (
    tag: string,
    reference: string,
    pattern: string,
    subscribedOnly: boolean,
  ): Promise<string> => {
    const label = subscribedOnly ? "LSUB" : "LIST"
    // An empty pattern with an empty reference asks for the hierarchy delimiter.
    if (pattern === "") {
      return `* ${label} (\\Noselect) "/" ""${CRLF}${ok(tag, `${label} completed.`)}`
    }

    const regex = patternToRegex(`${reference}${pattern}`)
    let out = ""
    for (const folder of await allFolders()) {
      if (subscribedOnly && !folder.subscribed) continue
      if (!regex.test(folder.name)) continue
      const attrs: string[] = []
      const special = folder.special_use ? SPECIAL_USE_ATTR[folder.special_use] : null
      if (special) attrs.push(special)
      out += `* ${label} (${attrs.join(" ")}) "/" ${quote(encodeMailbox(folder.name))}${CRLF}`
    }
    return out + ok(tag, `${label} completed.`)
  }

  const quote = (value: string): string => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

  // ----------------------------------------------------------------- auth --

  const finishLogin = async (tag: string, username: string, password: string): Promise<string> => {
    authState = null
    const result = await authenticateAddress(username, password)
    if (!result) {
      hooks.onAuthFailure?.(username)
      return no(tag, "Invalid credentials.", "AUTHENTICATIONFAILED")
    }
    identity = result
    hooks.onAuthSuccess?.()
    return `${capabilityLine()}${ok(tag, "Logged in.")}`
  }

  // ------------------------------------------------------------- messages --

  const resolveSet = (set: string, uid: boolean): Message[] => {
    if (!selected) return []
    const snapshot = selected.snapshot
    const maxUid = snapshot.length ? num(snapshot[snapshot.length - 1]!.uid) : 0
    const parsed = parseSequenceSet(set, uid ? maxUid : snapshot.length)
    return snapshot.filter((message, index) =>
      inSequenceSet(parsed, uid ? num(message.uid) : index + 1),
    )
  }

  const sequenceOf = (message: Message): number =>
    (selected?.snapshot.findIndex((m) => m.id === message.id) ?? -1) + 1

  // ------------------------------------------------------------- commands --

  const doSelect = async (tag: string, name: string, readOnly: boolean): Promise<string> => {
    const folder = await folderByName(name)
    if (!folder) return no(tag, "No such mailbox.", "TRYCREATE")

    const snapshot = await messagesIn(folder.id)
    selected = { folder, readOnly, snapshot }
    const status = await folderStatus(folder)

    const firstUnseen = snapshot.findIndex(
      (m) => !(m.flags ?? []).some((f) => f.toLowerCase() === "\\seen"),
    )

    let out = ""
    out += `* ${snapshot.length} EXISTS${CRLF}`
    out += `* ${status.recent} RECENT${CRLF}`
    out += `* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)${CRLF}`
    out += `* OK [PERMANENTFLAGS (${readOnly ? "" : "\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*"})] Permanent flags.${CRLF}`
    out += `* OK [UIDVALIDITY ${status.uidValidity}] UIDs valid.${CRLF}`
    out += `* OK [UIDNEXT ${status.uidNext}] Predicted next UID.${CRLF}`
    out += `* OK [HIGHESTMODSEQ ${status.highestModseq}] Highest modification sequence.${CRLF}`
    if (firstUnseen !== -1) {
      out += `* OK [UNSEEN ${firstUnseen + 1}] First unseen message.${CRLF}`
    }
    return (
      out +
      ok(
        tag,
        `${readOnly ? "EXAMINE" : "SELECT"} completed.`,
        readOnly ? "READ-ONLY" : "READ-WRITE",
      )
    )
  }

  const doFetch = async (tag: string, args: string, uid: boolean): Promise<string> => {
    if (!selected) return bad(tag, "No mailbox selected.")

    const reader = createReader(args)
    const set = reader.astring()
    const items = parseFetchItems(reader.rest())
    const targets = resolveSet(set, uid)

    // A UID FETCH always reports UID whether or not the client asked, because
    // the client has no other way to correlate the response.
    if (uid && !items.some((i) => i.kind === "uid")) {
      items.unshift({ name: "UID", kind: "uid" })
    }

    const wantsBody = needsBody(items)
    const marksSeen = setsSeen(items) && !selected.readOnly

    let out = ""
    for (const message of targets) {
      const raw = wantsBody ? await loadRaw(message) : null
      const sequence = sequenceOf(message)
      if (sequence === 0) continue

      if (marksSeen && !(message.flags ?? []).some((f) => f.toLowerCase() === "\\seen")) {
        const next = [...(message.flags ?? []), "\\Seen"]
        await setFlags(message.id, selected.folder.id, next)
        message.flags = next
      }

      out += renderFetch({ sequence, message, raw }, items)
    }

    return out + ok(tag, `${uid ? "UID " : ""}FETCH completed.`)
  }

  const doStore = async (tag: string, args: string, uid: boolean): Promise<string> => {
    if (!selected) return bad(tag, "No mailbox selected.")
    if (selected.readOnly) return no(tag, "Mailbox is read-only.")

    const reader = createReader(args)
    const set = reader.astring()
    const operation = reader.word()
    const listed = reader.parenthesised() || reader.rest()
    const wanted = listed.split(/\s+/).filter(Boolean)
    const silent = operation.endsWith(".SILENT")
    const mode = operation.replace(".SILENT", "")

    const targets = resolveSet(set, uid)
    let out = ""

    for (const message of targets) {
      const existing = message.flags ?? []
      let next: string[]
      if (mode === "+FLAGS") next = [...new Set([...existing, ...wanted])]
      else if (mode === "-FLAGS") {
        const remove = new Set(wanted.map((f) => f.toLowerCase()))
        next = existing.filter((f) => !remove.has(f.toLowerCase()))
      } else next = [...new Set(wanted)]

      await setFlags(message.id, selected.folder.id, next)
      message.flags = next

      if (!silent) {
        const sequence = sequenceOf(message)
        const suffix = uid ? ` UID ${num(message.uid)}` : ""
        out += `* ${sequence} FETCH (FLAGS (${next.join(" ")})${suffix})${CRLF}`
      }
    }

    return out + ok(tag, `${uid ? "UID " : ""}STORE completed.`)
  }

  const doCopy = async (
    tag: string,
    args: string,
    uid: boolean,
    move: boolean,
  ): Promise<string> => {
    if (!selected) return bad(tag, "No mailbox selected.")

    const reader = createReader(args)
    const set = reader.astring()
    const target = await folderByName(reader.astring())
    if (!target) return no(tag, "No such mailbox.", "TRYCREATE")

    const sources = resolveSet(set, uid)
    if (!sources.length) return ok(tag, `${move ? "MOVE" : "COPY"} completed.`)

    const result = await copyTo({
      messageIds: sources.map((m) => m.id),
      targetFolderId: target.id,
    })

    const refreshed = await reload(target)
    // UIDPLUS: the client can update its cache without re-fetching the target.
    const copyUid = `COPYUID ${num(refreshed.uid_validity)} ${formatSequenceSet(result.sourceUids)} ${formatSequenceSet(result.targetUids)}`

    if (!move) return ok(tag, "COPY completed.", copyUid)

    // MOVE is a copy plus an expunge that must be reported even though the
    // client did not ask for one.
    const removal = await expunge({
      folderId: selected.folder.id,
      messageIds: sources.map((m) => m.id),
    })
    let out = `* OK [${copyUid}] Moved.${CRLF}`
    out += await sync()
    return out + ok(tag, `MOVE completed. ${removal.uids.length} message(s) moved.`)
  }

  const doSearch = async (
    tag: string,
    args: string,
    uid: boolean,
    sort: boolean,
  ): Promise<string> => {
    if (!selected) return bad(tag, "No mailbox selected.")

    let criteriaText = args
    let sortKeys: ReturnType<typeof parseSortKeys> = []

    if (sort) {
      const reader = createReader(args)
      sortKeys = parseSortKeys(reader.parenthesised())
      reader.astring() // charset
      criteriaText = reader.rest()
    }

    const parsed = parseSearch(criteriaText)
    const snapshot = selected.snapshot
    const maxUid = snapshot.length ? num(snapshot[snapshot.length - 1]!.uid) : 0

    let candidates: Candidate[] = snapshot.map((message, index) => ({
      message,
      sequence: index + 1,
    }))

    // Headers are only loaded when a criterion actually needs them, and only
    // for the messages that reach that point.
    if (searchNeedsHeaders(parsed.criterion)) {
      candidates = await Promise.all(
        candidates.map(async (candidate) => {
          const raw = await loadRaw(candidate.message)
          return raw ? { ...candidate, headers: mime.parseMessage(raw).headers } : candidate
        }),
      )
    }

    let hits = candidates.filter((c) =>
      matches(parsed.criterion, c, { maxSequence: snapshot.length, maxUid }),
    )
    if (sort && sortKeys.length) hits = sortCandidates(hits, sortKeys)

    const values = hits.map((c) => (uid ? num(c.message.uid) : c.sequence))
    const label = sort ? "SORT" : "SEARCH"
    return `* ${label}${values.length ? ` ${values.join(" ")}` : ""}${CRLF}${ok(tag, `${uid ? "UID " : ""}${label} completed.`)}`
  }

  const doAppend = async (tag: string, args: string): Promise<string> => {
    if (!identity) return no(tag, "Not authenticated.")

    const reader = createReader(args)
    const folder = await folderByName(reader.astring())
    if (!folder) return no(tag, "No such mailbox.", "TRYCREATE")

    let flags: string[] = []
    let internalDate: Date | undefined

    // The optional flag list and date can appear in either order before the
    // message literal.
    while (true) {
      const at = reader.index()
      const next = reader.peek()
      if (next === "(") {
        flags = reader.parenthesised().split(/\s+/).filter(Boolean)
        continue
      }
      if (next === '"') {
        const value = reader.astring()
        const parsed = parseImapDate(value)
        if (parsed) {
          internalDate = parsed
          continue
        }
        reader.seek(at)
        break
      }
      break
    }

    const raw = reader.astring()
    if (!raw) return bad(tag, "APPEND needs a message literal.")

    const message = await deliver({
      addressId: identity.address.id,
      folderId: folder.id,
      raw,
      flags,
      internalDate,
    })

    const refreshed = await reload(folder)
    let out = ""
    if (selected?.folder.id === folder.id) out += await sync()
    return (
      out +
      ok(tag, "APPEND completed.", `APPENDUID ${num(refreshed.uid_validity)} ${num(message.uid)}`)
    )
  }

  const doCreate = async (tag: string, name: string): Promise<string> => {
    if (!identity) return no(tag, "Not authenticated.")
    const decoded = decodeMailbox(name).replace(/\/+$/, "")
    if (!decoded) return no(tag, "Invalid mailbox name.")
    if (decoded.toUpperCase() === "INBOX") return no(tag, "INBOX already exists.")

    const existing = await folderByName(name)
    if (existing) return no(tag, "Mailbox already exists.", "ALREADYEXISTS")

    // Creating "a/b/c" implies "a" and "a/b" — clients expect that, and a
    // hierarchy with holes in it lists strangely.
    const segments = decoded.split("/")
    for (let i = 1; i <= segments.length; i++) {
      const path = segments.slice(0, i).join("/")
      const present = await db().one<{ id: string }>(
        from(folders)
          .select("id")
          .where((q) => [q("address_id").equals(identity!.address.id), q("name").equals(path)]),
      )
      if (present) continue
      await db().execute(
        from(folders).insert({
          address_id: identity.address.id,
          name: path,
          uid_validity: uidValidity(),
        }),
      )
    }

    return ok(tag, "CREATE completed.")
  }

  const doDelete = async (tag: string, name: string): Promise<string> => {
    const folder = await folderByName(name)
    if (!folder) return no(tag, "No such mailbox.")
    if (folder.name === "INBOX") return no(tag, "Cannot delete INBOX.")

    if (selected?.folder.id === folder.id) selected = null
    await db().execute(
      from(folders)
        .where((q) => q("id").equals(folder.id))
        .del(),
    )
    return ok(tag, "DELETE completed.")
  }

  const doRename = async (tag: string, args: string): Promise<string> => {
    const reader = createReader(args)
    const folder = await folderByName(reader.astring())
    const target = decodeMailbox(reader.astring())
    if (!folder) return no(tag, "No such mailbox.")
    if (!target) return no(tag, "Invalid mailbox name.")
    if (await folderByName(target)) return no(tag, "Mailbox already exists.", "ALREADYEXISTS")

    // Renaming a parent moves its children with it.
    const children = (await allFolders()).filter((f) => f.name.startsWith(`${folder.name}/`))
    await db().execute(
      from(folders)
        .where((q) => q("id").equals(folder.id))
        .update({ name: target, updated_at: new Date() }),
    )
    for (const child of children) {
      await db().execute(
        from(folders)
          .where((q) => q("id").equals(child.id))
          .update({
            name: `${target}${child.name.slice(folder.name.length)}`,
            updated_at: new Date(),
          }),
      )
    }
    return ok(tag, "RENAME completed.")
  }

  const doStatus = async (tag: string, args: string): Promise<string> => {
    const reader = createReader(args)
    const name = reader.astring()
    const folder = await folderByName(name)
    if (!folder) return no(tag, "No such mailbox.")

    const wanted = reader.parenthesised().split(/\s+/).filter(Boolean)
    const status = await folderStatus(folder)
    const values: string[] = []
    for (const item of wanted) {
      switch (item.toUpperCase()) {
        case "MESSAGES":
          values.push(`MESSAGES ${status.messages}`)
          break
        case "RECENT":
          values.push(`RECENT ${status.recent}`)
          break
        case "UIDNEXT":
          values.push(`UIDNEXT ${status.uidNext}`)
          break
        case "UIDVALIDITY":
          values.push(`UIDVALIDITY ${status.uidValidity}`)
          break
        case "UNSEEN":
          values.push(`UNSEEN ${status.unseen}`)
          break
        case "HIGHESTMODSEQ":
          values.push(`HIGHESTMODSEQ ${status.highestModseq}`)
          break
        case "SIZE":
          values.push(`SIZE ${status.size}`)
          break
      }
    }
    return `* STATUS ${quote(encodeMailbox(folder.name))} (${values.join(" ")})${CRLF}${ok(tag, "STATUS completed.")}`
  }

  const doExpunge = async (tag: string, uidSet: string | null): Promise<string> => {
    if (!selected) return bad(tag, "No mailbox selected.")
    if (selected.readOnly) return no(tag, "Mailbox is read-only.")

    const deleted = selected.snapshot.filter((m) =>
      (m.flags ?? []).some((f) => f.toLowerCase() === "\\deleted"),
    )
    const scoped = uidSet
      ? deleted.filter((m) => resolveSet(uidSet, true).some((t) => t.id === m.id))
      : deleted

    if (scoped.length) {
      await expunge({ folderId: selected.folder.id, messageIds: scoped.map((m) => m.id) })
    }
    const out = await sync()
    return out + ok(tag, "EXPUNGE completed.")
  }

  const doSubscribe = async (tag: string, name: string, subscribed: boolean): Promise<string> => {
    const folder = await folderByName(name)
    if (!folder) return no(tag, "No such mailbox.")
    await db().execute(
      from(folders)
        .where((q) => q("id").equals(folder.id))
        .update({ subscribed, updated_at: new Date() }),
    )
    return ok(tag, `${subscribed ? "SUBSCRIBE" : "UNSUBSCRIBE"} completed.`)
  }

  // ------------------------------------------------------------ dispatch --

  const dispatch = async (line: string): Promise<string> => {
    const reader = createReader(line)
    const tag = reader.astring()
    if (!tag) return `* BAD Missing command tag.${CRLF}`
    const name = reader.word()
    const args = reader.rest()

    // ---- any state ----
    switch (name) {
      case "CAPABILITY":
        return capabilityLine() + ok(tag, "CAPABILITY completed.")
      case "NOOP": {
        const updates = await sync()
        return updates + ok(tag, "NOOP completed.")
      }
      case "LOGOUT":
        closing = true
        return `* BYE ${config.hostname} closing connection.${CRLF}${ok(tag, "LOGOUT completed.")}`
      case "ID":
        return `* ID ("name" "Corsair" "version" "0.1.0")${CRLF}${ok(tag, "ID completed.")}`
      case "ENABLE":
        return ok(tag, "ENABLE completed.")
    }

    // ---- not authenticated ----
    if (!identity) {
      switch (name) {
        case "STARTTLS":
          if (!hooks.startTls) return no(tag, "STARTTLS is not available.")
          if (hooks.isSecure()) return bad(tag, "TLS is already active.")
          hooks.startTls()
          return ok(tag, "Begin TLS negotiation now.")

        case "LOGIN": {
          if (!hooks.isSecure()) {
            // Refusing plaintext credentials is the whole reason LOGINDISABLED
            // exists. A client that ignores the capability still must not get a
            // password across the wire in the clear.
            return no(tag, "Encryption required before LOGIN.", "PRIVACYREQUIRED")
          }
          const inner = createReader(args)
          return finishLogin(tag, inner.astring(), inner.astring())
        }

        case "AUTHENTICATE": {
          if (!hooks.isSecure()) {
            return no(tag, "Encryption required before AUTHENTICATE.", "PRIVACYREQUIRED")
          }
          const inner = createReader(args)
          const mechanism = inner.word()
          const initial = inner.rest().trim()

          if (mechanism === "PLAIN") {
            if (initial) {
              const decoded = Buffer.from(initial, "base64").toString("utf8").split("\0")
              return finishLogin(tag, decoded[1] ?? "", decoded[2] ?? "")
            }
            authState = { mechanism: "plain", tag }
            return `+ ${CRLF}`
          }
          if (mechanism === "LOGIN") {
            authState = { mechanism: "login", tag }
            return `+ ${Buffer.from("Username:").toString("base64")}${CRLF}`
          }
          return no(tag, "Unsupported authentication mechanism.")
        }

        default:
          return no(tag, "Please authenticate first.")
      }
    }

    // ---- authenticated ----
    switch (name) {
      case "SELECT":
        return doSelect(tag, createReader(args).astring(), false)
      case "EXAMINE":
        return doSelect(tag, createReader(args).astring(), true)
      case "CREATE":
        return doCreate(tag, createReader(args).astring())
      case "DELETE":
        return doDelete(tag, createReader(args).astring())
      case "RENAME":
        return doRename(tag, args)
      case "SUBSCRIBE":
        return doSubscribe(tag, createReader(args).astring(), true)
      case "UNSUBSCRIBE":
        return doSubscribe(tag, createReader(args).astring(), false)
      case "LIST": {
        const inner = createReader(args)
        return listResponse(tag, inner.astring(), inner.astring(), false)
      }
      case "LSUB": {
        const inner = createReader(args)
        return listResponse(tag, inner.astring(), inner.astring(), true)
      }
      case "STATUS":
        return doStatus(tag, args)
      case "APPEND":
        return doAppend(tag, args)
      case "NAMESPACE":
        return `* NAMESPACE (("" "/")) NIL NIL${CRLF}${ok(tag, "NAMESPACE completed.")}`

      case "IDLE":
        idleTag = tag
        return `+ idling${CRLF}`

      case "UNSELECT":
        selected = null
        return ok(tag, "UNSELECT completed.")

      case "CLOSE": {
        if (!selected) return bad(tag, "No mailbox selected.")
        // CLOSE expunges silently — no untagged EXPUNGE, by specification.
        if (!selected.readOnly) {
          const deleted = selected.snapshot.filter((m) =>
            (m.flags ?? []).some((f) => f.toLowerCase() === "\\deleted"),
          )
          if (deleted.length) {
            await expunge({ folderId: selected.folder.id, messageIds: deleted.map((m) => m.id) })
          }
        }
        selected = null
        return ok(tag, "CLOSE completed.")
      }

      case "CHECK":
        return ok(tag, "CHECK completed.")

      case "EXPUNGE":
        return doExpunge(tag, null)

      case "SEARCH":
        return doSearch(tag, args, false, false)

      case "SORT":
        return doSearch(tag, args, false, true)

      case "FETCH":
        return doFetch(tag, args, false)

      case "STORE":
        return doStore(tag, args, false)

      case "COPY":
        return doCopy(tag, args, false, false)

      case "MOVE":
        return doCopy(tag, args, false, true)

      case "UID": {
        const inner = createReader(args)
        const sub = inner.word()
        const rest = inner.rest()
        switch (sub) {
          case "FETCH":
            return doFetch(tag, rest, true)
          case "STORE":
            return doStore(tag, rest, true)
          case "COPY":
            return doCopy(tag, rest, true, false)
          case "MOVE":
            return doCopy(tag, rest, true, true)
          case "SEARCH":
            return doSearch(tag, rest, true, false)
          case "SORT":
            return doSearch(tag, rest, true, true)
          case "EXPUNGE":
            return doExpunge(tag, createReader(rest).astring())
          default:
            return bad(tag, `Unknown UID subcommand: ${sub}`)
        }
      }

      default:
        return bad(tag, `Unknown command: ${name}`)
    }
  }

  // ---------------------------------------------------------------- feed --

  const handleAuthContinuation = async (line: string): Promise<string> => {
    const state = authState!
    if (line === "*") {
      authState = null
      return bad(state.tag, "Authentication cancelled.")
    }
    const decoded = Buffer.from(line, "base64").toString("utf8")

    if (state.mechanism === "plain") {
      const parts = decoded.split("\0")
      return finishLogin(state.tag, parts[1] ?? "", parts[2] ?? "")
    }
    if (!state.username) {
      authState = { ...state, username: decoded }
      return `+ ${Buffer.from("Password:").toString("base64")}${CRLF}`
    }
    return finishLogin(state.tag, state.username, decoded)
  }

  return {
    greeting: () =>
      `* OK [CAPABILITY ${CAPABILITIES.join(" ")}${hooks.startTls && !hooks.isSecure() ? " STARTTLS" : ""}] ${config.hostname} Corsair IMAP ready${CRLF}`,

    feed: async (chunk) => {
      buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("latin1")
      let out = ""

      while (true) {
        if (awaitingLiteral > 0) {
          if (buffer.length < awaitingLiteral) break
          command += buffer.slice(0, awaitingLiteral)
          buffer = buffer.slice(awaitingLiteral)
          awaitingLiteral = 0
          continue
        }

        const end = buffer.indexOf(CRLF)
        if (end === -1) {
          if (buffer.length > config.maxMessageBytes) {
            buffer = ""
            closing = true
            out += `* BYE Line too long.${CRLF}`
          }
          break
        }

        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)

        // A trailing {n} means the rest of this command arrives as raw octets.
        const literal = line.match(/\{(\d+)(\+?)\}$/)
        if (literal) {
          const size = Number(literal[1])
          if (size > config.maxMessageBytes) {
            out += bad("*", "Literal too large.")
            command = ""
            continue
          }
          command += `${line}${CRLF}`
          awaitingLiteral = size
          // LITERAL+ means the client is not waiting for permission.
          if (literal[2] !== "+") out += `+ Ready for literal data${CRLF}`
          continue
        }

        command += line

        if (idleTag) {
          if (command.trim().toUpperCase() === "DONE") {
            const tag = idleTag
            idleTag = null
            out += await sync()
            out += ok(tag, "IDLE terminated.")
          }
          command = ""
          continue
        }

        if (authState) {
          out += await handleAuthContinuation(command.trim())
          command = ""
          continue
        }

        if (command.trim()) {
          try {
            out += await dispatch(command)
          } catch (e) {
            console.error("[corsair] imap command failed:", e)
            const tag = createReader(command).astring() || "*"
            out += no(tag, "Internal error handling that command.")
          }
        }
        command = ""
        if (closing) break
      }

      return out
    },

    poll: async () => (idleTag ? sync() : ""),
    isIdling: () => idleTag !== null,
    shouldClose: () => closing,

    resetAfterTls: () => {
      buffer = ""
      command = ""
      awaitingLiteral = 0
      authState = null
      identity = null
      selected = null
      idleTag = null
    },

    close: () => {
      selected = null
      identity = null
    },
  }
}

/** Exposed so the worker can bump a folder when mail arrives outside a session. */
export const touchFolder = bumpModseq
export type { Message }
export { messages }
