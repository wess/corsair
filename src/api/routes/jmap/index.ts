import { from } from "@atlas/db"
import { get, json, post, type Route, text } from "@atlas/server"
import { authenticateAddress, type MailIdentity, resolveMailSession } from "../../../auth/index.ts"
import { config } from "../../../config/index.ts"
import { db } from "../../../db/index.ts"
import { sign } from "../../../dkim/index.ts"
import { activeDkimKey } from "../../../domains/index.ts"
import { rfcMessageId, uidValidity } from "../../../ids/index.ts"
import * as mime from "../../../mime/index.ts"
import { enqueue } from "../../../outbound/index.ts"
import { type Folder, folders, type Message, messages } from "../../../schema/index.ts"
import { getRaw } from "../../../storage/index.ts"
import { deliver, expunge, moveTo, setFlags } from "../../../store/index.ts"

/**
 * JMAP — RFC 8620 (core) and RFC 8621 (mail).
 *
 * The modern alternative to IMAP: one HTTPS endpoint, JSON in and out, batched
 * method calls, and state strings so a client can ask "what changed since?"
 * rather than re-walking a mailbox. It reads exactly the same store IMAP and
 * POP3 do — mail delivered over SMTP is visible over all four without any
 * synchronisation between them, because there is only one copy.
 *
 * The subset here is what a real client actually calls: Mailbox, Email, Thread,
 * Identity, and EmailSubmission. `SearchSnippet`, `VacationResponse`, and the
 * push channels are not implemented, and are absent from the advertised
 * capabilities rather than stubbed — a client must be able to discover that.
 */

const CORE = "urn:ietf:params:jmap:core"
const MAIL = "urn:ietf:params:jmap:mail"
const SUBMISSION = "urn:ietf:params:jmap:submission"

/** JMAP keywords and IMAP flags are the same thing under two names. */
const FLAG_TO_KEYWORD: Record<string, string> = {
  "\\seen": "$seen",
  "\\flagged": "$flagged",
  "\\draft": "$draft",
  "\\answered": "$answered",
  "\\deleted": "$deleted",
}
const KEYWORD_TO_FLAG: Record<string, string> = {
  $seen: "\\Seen",
  $flagged: "\\Flagged",
  $draft: "\\Draft",
  $answered: "\\Answered",
  $deleted: "\\Deleted",
}

const keywordsOf = (message: Message): Record<string, true> => {
  const out: Record<string, true> = {}
  for (const flag of message.flags ?? []) {
    out[FLAG_TO_KEYWORD[flag.toLowerCase()] ?? flag] = true
  }
  return out
}

const flagsOf = (keywords: Record<string, unknown>): string[] =>
  Object.keys(keywords)
    .filter((k) => keywords[k])
    .map((k) => KEYWORD_TO_FLAG[k.toLowerCase()] ?? k)

/**
 * RFC 6154 special-use names map onto JMAP roles almost one to one; `inbox` is
 * the only one that differs from the folder's own attribute.
 */
const roleOf = (folder: Folder): string | null => folder.special_use ?? null

// ---------------------------------------------------------------- session --

const authenticate = async (conn: { headers: Headers }): Promise<MailIdentity | null> => {
  // A browser client carries the webmail cookie; a native client sends Basic
  // credentials, which is what every JMAP client in the wild does.
  const cookie = await resolveMailSession(conn.headers.get("cookie"))
  if (cookie) return cookie

  const header = conn.headers.get("authorization")
  const basic = header?.match(/^Basic\s+(.+)$/i)?.[1]
  if (!basic) return null

  let decoded = ""
  try {
    decoded = Buffer.from(basic, "base64").toString("utf8")
  } catch {
    return null
  }
  const colon = decoded.indexOf(":")
  if (colon === -1) return null
  return authenticateAddress(decoded.slice(0, colon), decoded.slice(colon + 1))
}

const unauthorized = (conn: never) => {
  const response = json(conn, 401, { type: "urn:ietf:params:jmap:error:unauthorized" })
  return {
    ...response,
    respHeaders: new Headers([
      ...response.respHeaders,
      ["www-authenticate", 'Basic realm="Corsair JMAP", charset="UTF-8"'],
    ]),
  }
}

/**
 * The account state string.
 *
 * Derived from the highest modseq across the mailbox's folders, which already
 * advances on every delivery, flag change, and expunge — so it changes exactly
 * when something a client cares about changes, and never otherwise.
 */
const accountState = async (addressId: string): Promise<string> => {
  const row = await db().one<{ state: string }>({
    text: `SELECT coalesce(max(highest_modseq), 0)::text AS state
             FROM folders WHERE address_id = $1`,
    values: [addressId],
  })
  return row?.state ?? "0"
}

// ------------------------------------------------------------- references --

type MethodCall = [string, Record<string, any>, string]

/**
 * Resolves a `#property` back-reference against an earlier response.
 *
 * This is what makes JMAP a batching protocol rather than a JSON-shaped REST
 * API: a client sends `Email/query` and `Email/get` in one request, with the
 * second taking its ids from the first. Without it every client pays a round
 * trip per step.
 */
const resolveReferences = (
  args: Record<string, any>,
  responses: MethodCall[],
): Record<string, any> => {
  const out: Record<string, any> = {}

  for (const [key, value] of Object.entries(args)) {
    if (!key.startsWith("#")) {
      out[key] = value
      continue
    }

    const reference = value as { resultOf?: string; name?: string; path?: string }
    const source = responses.find((r) => r[2] === reference.resultOf && r[0] === reference.name)
    if (!source) continue

    // The path is a restricted JSON pointer; `/ids` and `/list/*/id` cover what
    // clients actually send.
    const path = (reference.path ?? "").replace(/^\//, "").split("/")
    let current: unknown = source[1]
    for (const segment of path) {
      if (segment === "*") {
        current = Array.isArray(current)
          ? current.map((item) => item as Record<string, unknown>)
          : current
        continue
      }
      if (Array.isArray(current)) {
        current = current.map((item) => (item as Record<string, unknown>)?.[segment])
      } else {
        current = (current as Record<string, unknown>)?.[segment]
      }
    }
    out[key.slice(1)] = current
  }

  return out
}

// ------------------------------------------------------------- Mailbox --

const mailboxObject = async (folder: Folder) => {
  const counts = await db().one<{ total: string; unread: string }>({
    text: `SELECT count(*)::text AS total,
                  count(*) FILTER (WHERE NOT (flags @> '["\\\\Seen"]'::jsonb))::text AS unread
             FROM messages WHERE folder_id = $1 AND expunged_at IS NULL`,
    values: [folder.id],
  })

  const slash = folder.name.lastIndexOf("/")
  return {
    id: folder.id,
    name: slash === -1 ? folder.name : folder.name.slice(slash + 1),
    parentId: null as string | null,
    role: roleOf(folder),
    sortOrder: folder.special_use === "inbox" ? 0 : 10,
    totalEmails: Number(counts?.total ?? 0),
    unreadEmails: Number(counts?.unread ?? 0),
    // Threads are not tracked separately from messages, so these mirror the
    // message counts rather than being wrong in a subtler way.
    totalThreads: Number(counts?.total ?? 0),
    unreadThreads: Number(counts?.unread ?? 0),
    myRights: {
      mayReadItems: true,
      mayAddItems: true,
      mayRemoveItems: true,
      maySetSeen: true,
      maySetKeywords: true,
      mayCreateChild: true,
      mayRename: !folder.special_use,
      mayDelete: !folder.special_use,
      maySubmit: true,
    },
    isSubscribed: folder.subscribed,
  }
}

// --------------------------------------------------------------- Email --

const addressList = (value: string | null) =>
  value ? mime.parseAddressList(value).map((a) => ({ name: a.name, email: a.address })) : null

const emailObject = async (
  message: Message,
  properties: string[] | null,
  bodyProperties: { fetchTextBodyValues?: boolean; fetchHTMLBodyValues?: boolean } = {},
) => {
  const wants = (name: string) => !properties || properties.includes(name)

  const base: Record<string, unknown> = {
    id: message.id,
    blobId: message.id,
    threadId: message.thread_id ?? message.id,
    mailboxIds: { [message.folder_id]: true },
    keywords: keywordsOf(message),
    size: message.size,
    receivedAt: message.internal_date.toISOString(),
    hasAttachment: message.has_attachments,
    preview: message.snippet ?? "",
    subject: message.subject,
  }

  // Anything below needs the original bytes, so it is only read when asked for.
  const needsBody =
    wants("bodyStructure") ||
    wants("textBody") ||
    wants("htmlBody") ||
    wants("attachments") ||
    wants("bodyValues") ||
    wants("headers") ||
    wants("from") ||
    wants("to") ||
    wants("sentAt")

  if (!needsBody) return base

  const raw = await getRaw({ storageKey: message.storage_key, messageId: message.id })
  if (!raw) return base

  const parsed = mime.parseMessage(raw)
  const header = (name: string) => mime.headerValue(parsed.headers, name)

  base.from = addressList(header("from"))
  base.to = addressList(header("to"))
  base.cc = addressList(header("cc"))
  base.bcc = addressList(header("bcc"))
  base.replyTo = addressList(header("reply-to"))
  base.sentAt = header("date")
  base.messageId = header("message-id") ? [header("message-id")] : null
  base.inReplyTo = header("in-reply-to") ? [header("in-reply-to")] : null
  base.references = header("references")?.trim().split(/\s+/) ?? null

  if (wants("headers")) {
    base.headers = parsed.headers.map((h) => ({ name: h.name, value: ` ${h.value}` }))
  }

  const bodies = mime.bodyText(raw, parsed)
  const partsOf = (subtype: string) => {
    const out: Record<string, unknown>[] = []
    mime.walk(parsed.root, (part) => {
      if (part.type !== "text" || part.subtype !== subtype) return
      if (part.disposition?.type === "attachment") return
      out.push({
        partId: part.section || "1",
        blobId: `${message.id}:${part.section || "1"}`,
        size: part.size,
        type: `${part.type}/${part.subtype}`,
        charset: part.params.charset ?? "utf-8",
      })
    })
    return out
  }

  base.textBody = partsOf("plain")
  base.htmlBody = partsOf("html")

  base.attachments = mime.attachmentParts(parsed).map((part) => ({
    partId: part.section,
    blobId: `${message.id}:${part.section}`,
    size: part.size,
    name: part.disposition?.params.filename ?? part.params.name ?? null,
    type: `${part.type}/${part.subtype}`,
    disposition: part.disposition?.type ?? "attachment",
    cid: part.id?.replace(/^<|>$/g, "") ?? null,
  }))

  if (bodyProperties.fetchTextBodyValues || bodyProperties.fetchHTMLBodyValues) {
    const values: Record<string, unknown> = {}
    if (bodyProperties.fetchTextBodyValues) {
      for (const part of base.textBody as { partId: string }[]) {
        values[part.partId] = { value: bodies.text, isEncodingProblem: false, isTruncated: false }
      }
    }
    if (bodyProperties.fetchHTMLBodyValues) {
      for (const part of base.htmlBody as { partId: string }[]) {
        values[part.partId] = { value: bodies.html, isEncodingProblem: false, isTruncated: false }
      }
    }
    base.bodyValues = values
  }

  return base
}

// ------------------------------------------------------------ dispatch --

type Ctx = { identity: MailIdentity; accountId: string }

const ownedFolder = (ctx: Ctx, id: string) =>
  db().one<Folder>(
    from(folders).where((q) => [
      q("id").equals(id),
      q("address_id").equals(ctx.identity.address.id),
    ]),
  )

const ownedMessages = (ctx: Ctx, ids: string[]) =>
  ids.length
    ? db().all<Message>(
        from(messages).where((q) => [
          q("address_id").equals(ctx.identity.address.id),
          q("expunged_at").isNull(),
          q("id").inList(ids),
        ]),
      )
    : Promise.resolve([])

const invoke = async (
  name: string,
  args: Record<string, any>,
  ctx: Ctx,
): Promise<[string, Record<string, unknown>]> => {
  // Every method takes an accountId, and a mismatched one must be refused
  // rather than silently served from the caller's own account.
  if (args.accountId && args.accountId !== ctx.accountId) {
    return ["error", { type: "accountNotFound" }]
  }

  switch (name) {
    case "Core/echo":
      return ["Core/echo", args]

    // ---------------------------------------------------------- Mailbox --

    case "Mailbox/get": {
      const all = await db().all<Folder>(
        from(folders)
          .where((q) => q("address_id").equals(ctx.identity.address.id))
          .orderBy("name", "ASC"),
      )
      const wanted: string[] | null = args.ids ?? null
      const selected = wanted ? all.filter((f) => wanted.includes(f.id)) : all

      return [
        "Mailbox/get",
        {
          accountId: ctx.accountId,
          state: await accountState(ctx.identity.address.id),
          list: await Promise.all(selected.map(mailboxObject)),
          notFound: wanted ? wanted.filter((id) => !all.some((f) => f.id === id)) : [],
        },
      ]
    }

    case "Mailbox/query": {
      const all = await db().all<Folder>(
        from(folders)
          .where((q) => q("address_id").equals(ctx.identity.address.id))
          .orderBy("name", "ASC"),
      )
      return [
        "Mailbox/query",
        {
          accountId: ctx.accountId,
          queryState: await accountState(ctx.identity.address.id),
          canCalculateChanges: false,
          position: 0,
          ids: all.map((f) => f.id),
          total: all.length,
        },
      ]
    }

    case "Mailbox/set": {
      const created: Record<string, unknown> = {}
      const notCreated: Record<string, unknown> = {}
      const updated: Record<string, unknown> = {}
      const destroyed: string[] = []
      const notDestroyed: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(args.create ?? {})) {
        const spec = value as { name?: string }
        const name = String(spec.name ?? "").trim()
        if (!name) {
          notCreated[key] = { type: "invalidProperties", properties: ["name"] }
          continue
        }
        const clash = await db().one<{ id: string }>(
          from(folders)
            .select("id")
            .where((q) => [
              q("address_id").equals(ctx.identity.address.id),
              q("name").equals(name),
            ]),
        )
        if (clash) {
          notCreated[key] = {
            type: "invalidArguments",
            description: "A mailbox with that name already exists.",
          }
          continue
        }
        const row = await db().one<Pick<Folder, "id">>(
          from(folders)
            .insert({
              address_id: ctx.identity.address.id,
              name,
              uid_validity: uidValidity(),
            })
            .returning("id"),
        )
        created[key] = { id: row!.id, role: null, sortOrder: 10, isSubscribed: true }
      }

      for (const [id, value] of Object.entries(args.update ?? {})) {
        const folder = await ownedFolder(ctx, id)
        if (!folder) continue
        const patch = value as Record<string, unknown>
        const next: Record<string, unknown> = { updated_at: new Date() }
        if (typeof patch.name === "string") next.name = patch.name
        if (typeof patch.isSubscribed === "boolean") next.subscribed = patch.isSubscribed
        await db().execute(
          from(folders)
            .where((q) => q("id").equals(folder.id))
            .update(next),
        )
        updated[id] = null
      }

      for (const id of (args.destroy ?? []) as string[]) {
        const folder = await ownedFolder(ctx, id)
        if (!folder) continue
        if (folder.special_use) {
          notDestroyed[id] = {
            type: "forbidden",
            description: `${folder.name} is a system mailbox.`,
          }
          continue
        }
        await db().execute(
          from(folders)
            .where((q) => q("id").equals(folder.id))
            .del(),
        )
        destroyed.push(id)
      }

      return [
        "Mailbox/set",
        {
          accountId: ctx.accountId,
          oldState: null,
          newState: await accountState(ctx.identity.address.id),
          created,
          notCreated,
          updated,
          notUpdated: {},
          destroyed,
          notDestroyed,
        },
      ]
    }

    // ------------------------------------------------------------ Email --

    case "Email/query": {
      const filter = (args.filter ?? {}) as Record<string, any>
      const values: unknown[] = [ctx.identity.address.id]
      let where = "address_id = $1 AND expunged_at IS NULL"

      if (filter.inMailbox) {
        values.push(filter.inMailbox)
        where += ` AND folder_id = $${values.length}`
      }
      if (filter.hasKeyword) {
        values.push(JSON.stringify([KEYWORD_TO_FLAG[filter.hasKeyword] ?? filter.hasKeyword]))
        where += ` AND flags @> $${values.length}::jsonb`
      }
      if (filter.notKeyword) {
        values.push(JSON.stringify([KEYWORD_TO_FLAG[filter.notKeyword] ?? filter.notKeyword]))
        where += ` AND NOT (flags @> $${values.length}::jsonb)`
      }
      if (filter.text || filter.subject || filter.body) {
        values.push(`%${filter.text ?? filter.subject ?? filter.body}%`)
        const p = `$${values.length}`
        where += ` AND (subject ILIKE ${p} OR from_address ILIKE ${p} OR search_text ILIKE ${p})`
      }
      if (filter.from) {
        values.push(`%${filter.from}%`)
        where += ` AND from_address ILIKE $${values.length}`
      }
      if (filter.after) {
        values.push(new Date(filter.after))
        where += ` AND internal_date >= $${values.length}`
      }
      if (filter.before) {
        values.push(new Date(filter.before))
        where += ` AND internal_date < $${values.length}`
      }

      // Only `receivedAt` is offered as a sort, and unrecognised sorts fall
      // back to it rather than being interpolated into the statement.
      const descending = (args.sort ?? [])[0]?.isAscending === false ? "DESC" : "DESC"
      const limit = Math.min(Number(args.limit ?? 50) || 50, 500)
      const position = Math.max(0, Number(args.position ?? 0) || 0)

      const total = await db().one<{ count: string }>({
        text: `SELECT count(*)::text AS count FROM messages WHERE ${where}`,
        values,
      })
      const rows = await db().all<{ id: string }>({
        text: `SELECT id FROM messages WHERE ${where}
                ORDER BY internal_date ${descending}
                LIMIT ${limit} OFFSET ${position}`,
        values,
      })

      return [
        "Email/query",
        {
          accountId: ctx.accountId,
          queryState: await accountState(ctx.identity.address.id),
          canCalculateChanges: false,
          position,
          ids: rows.map((r) => r.id),
          total: Number(total?.count ?? 0),
        },
      ]
    }

    case "Email/get": {
      const ids: string[] = Array.isArray(args.ids) ? args.ids.flat().filter(Boolean) : []
      const rows = await ownedMessages(ctx, ids)
      const list = await Promise.all(
        rows.map((row) =>
          emailObject(row, args.properties ?? null, {
            fetchTextBodyValues: Boolean(args.fetchTextBodyValues),
            fetchHTMLBodyValues: Boolean(args.fetchHTMLBodyValues),
          }),
        ),
      )
      return [
        "Email/get",
        {
          accountId: ctx.accountId,
          state: await accountState(ctx.identity.address.id),
          list,
          notFound: ids.filter((id) => !rows.some((r) => r.id === id)),
        },
      ]
    }

    case "Email/set": {
      const updated: Record<string, unknown> = {}
      const destroyed: string[] = []

      for (const [id, value] of Object.entries(args.update ?? {})) {
        const [message] = await ownedMessages(ctx, [id])
        if (!message) continue
        const patch = value as Record<string, any>

        // Both the whole-object form (`keywords`) and the patch form
        // (`keywords/$seen: true`) are in the specification, and clients send
        // whichever their library implements.
        let flags = [...(message.flags ?? [])]
        if (patch.keywords && typeof patch.keywords === "object") {
          flags = flagsOf(patch.keywords)
        }
        for (const [key, on] of Object.entries(patch)) {
          const keyword = key.match(/^keywords\/(.+)$/)?.[1]
          if (!keyword) continue
          const flag = KEYWORD_TO_FLAG[keyword.toLowerCase()] ?? keyword
          flags = on
            ? [...new Set([...flags, flag])]
            : flags.filter((f) => f.toLowerCase() !== flag.toLowerCase())
        }
        await setFlags(message.id, message.folder_id, flags)

        // A move is expressed as a change of mailboxIds.
        const target = patch.mailboxIds
          ? Object.keys(patch.mailboxIds).find((k) => patch.mailboxIds[k])
          : Object.entries(patch)
              .map(([k, on]) => (on ? k.match(/^mailboxIds\/(.+)$/)?.[1] : null))
              .find(Boolean)

        if (target && target !== message.folder_id) {
          const folder = await ownedFolder(ctx, target)
          // moveTo rather than copy+expunge: JMAP requires the Email id to
          // survive a change of mailbox.
          if (folder) await moveTo({ messageIds: [message.id], targetFolderId: folder.id })
        }

        updated[id] = null
      }

      for (const id of (args.destroy ?? []) as string[]) {
        const [message] = await ownedMessages(ctx, [id])
        if (!message) continue
        await expunge({ folderId: message.folder_id, messageIds: [message.id] })
        destroyed.push(id)
      }

      return [
        "Email/set",
        {
          accountId: ctx.accountId,
          oldState: null,
          newState: await accountState(ctx.identity.address.id),
          created: {},
          notCreated: {},
          updated,
          notUpdated: {},
          destroyed,
          notDestroyed: {},
        },
      ]
    }

    case "Email/changes": {
      // `sinceState` is a modseq, which is exactly what the store already
      // advances on every change.
      const since = BigInt(String(args.sinceState ?? "0") || "0")
      const changed = await db().all<{ id: string }>({
        text: `SELECT id FROM messages
                WHERE address_id = $1 AND expunged_at IS NULL AND modseq > $2
                ORDER BY modseq LIMIT 500`,
        values: [ctx.identity.address.id, since],
      })
      const removed = await db().all<{ id: string }>({
        text: `SELECT id FROM messages
                WHERE address_id = $1 AND expunged_at IS NOT NULL AND modseq > $2
                ORDER BY modseq LIMIT 500`,
        values: [ctx.identity.address.id, since],
      })
      return [
        "Email/changes",
        {
          accountId: ctx.accountId,
          oldState: String(since),
          newState: await accountState(ctx.identity.address.id),
          hasMoreChanges: false,
          created: changed.map((r) => r.id),
          updated: [],
          destroyed: removed.map((r) => r.id),
        },
      ]
    }

    // ----------------------------------------------------------- Thread --

    case "Thread/get": {
      const ids: string[] = Array.isArray(args.ids) ? args.ids.flat().filter(Boolean) : []
      const list = await Promise.all(
        ids.map(async (id) => {
          const rows = await db().all<{ id: string }>({
            text: `SELECT id FROM messages
                    WHERE address_id = $1 AND expunged_at IS NULL
                      AND coalesce(thread_id, id::text) = $2
                    ORDER BY internal_date`,
            values: [ctx.identity.address.id, id],
          })
          return { id, emailIds: rows.map((r) => r.id) }
        }),
      )
      return [
        "Thread/get",
        {
          accountId: ctx.accountId,
          state: await accountState(ctx.identity.address.id),
          list: list.filter((t) => t.emailIds.length),
          notFound: list.filter((t) => !t.emailIds.length).map((t) => t.id),
        },
      ]
    }

    // --------------------------------------------------------- Identity --

    case "Identity/get":
      return [
        "Identity/get",
        {
          accountId: ctx.accountId,
          state: "1",
          list: [
            {
              id: ctx.identity.address.id,
              name: ctx.identity.address.name ?? ctx.identity.email,
              email: ctx.identity.email,
              replyTo: null,
              bcc: null,
              textSignature: "",
              htmlSignature: "",
              mayDelete: false,
            },
          ],
          notFound: [],
        },
      ]

    // -------------------------------------------------- EmailSubmission --

    case "EmailSubmission/set": {
      const created: Record<string, unknown> = {}
      const notCreated: Record<string, unknown> = {}

      for (const [key, value] of Object.entries(args.create ?? {})) {
        const spec = value as { emailId?: string; envelope?: any }
        const [message] = await ownedMessages(ctx, [String(spec.emailId ?? "")])
        if (!message) {
          notCreated[key] = { type: "invalidProperties", properties: ["emailId"] }
          continue
        }
        if (ctx.identity.domain.status !== "active") {
          notCreated[key] = {
            type: "forbiddenFrom",
            description: `${ctx.identity.domain.name} is not verified yet.`,
          }
          continue
        }

        const raw = await getRaw({ storageKey: message.storage_key, messageId: message.id })
        if (!raw) {
          notCreated[key] = { type: "blobNotFound" }
          continue
        }

        const recipients: string[] =
          spec.envelope?.rcptTo?.map((r: { email: string }) => r.email) ??
          mime
            .parseAddressList(mime.headerValue(mime.parseMessage(raw).headers, "to"))
            .map((a) => a.address)

        if (!recipients.length) {
          notCreated[key] = { type: "noRecipients" }
          continue
        }

        const dkim = await activeDkimKey(ctx.identity.domain.id)
        const signed = dkim
          ? sign({
              raw,
              domain: ctx.identity.domain.name,
              selector: dkim.selector,
              privateKey: dkim.private_key,
            })
          : raw

        await enqueue({
          raw: signed,
          mailFrom: spec.envelope?.mailFrom?.email ?? ctx.identity.email,
          recipients,
          addressId: ctx.identity.address.id,
          domainId: ctx.identity.domain.id,
        })

        created[key] = {
          id: message.id,
          sendAt: new Date().toISOString(),
          undoStatus: "final",
        }
      }

      // A submission usually arrives with an `onSuccessUpdateEmail` asking for
      // the draft to be moved to Sent and unflagged as a draft.
      const onSuccess = args.onSuccessUpdateEmail as Record<string, any> | undefined
      if (onSuccess) {
        for (const [, patch] of Object.entries(onSuccess)) {
          const emailId = Object.values(created)[0] as { id?: string } | undefined
          if (!emailId?.id) continue
          await invoke("Email/set", { update: { [emailId.id]: patch } }, ctx)
        }
      }

      return [
        "EmailSubmission/set",
        {
          accountId: ctx.accountId,
          oldState: null,
          newState: await accountState(ctx.identity.address.id),
          created,
          notCreated,
          updated: {},
          notUpdated: {},
          destroyed: [],
          notDestroyed: {},
        },
      ]
    }

    default:
      return ["error", { type: "unknownMethod", description: `${name} is not implemented.` }]
  }
}

// ------------------------------------------------------------------ routes --

export const jmapRoutes: Route[] = [
  /**
   * The session resource. A client is given exactly one URL — this one — and
   * discovers everything else from it, which is why the capability list has to
   * be honest about what is missing.
   */
  get("/.well-known/jmap", async (c) => {
    const identity = await authenticate(c)
    if (!identity) return unauthorized(c as never)

    const accountId = identity.address.id
    const base = config.publicUrl.replace(/\/+$/, "")

    return json(c, 200, {
      capabilities: {
        [CORE]: {
          maxSizeUpload: config.maxMessageBytes,
          maxConcurrentUpload: 4,
          maxSizeRequest: 10_000_000,
          maxConcurrentRequests: 4,
          maxCallsInRequest: 32,
          maxObjectsInGet: 500,
          maxObjectsInSet: 500,
          collationAlgorithms: ["i;ascii-casemap"],
        },
        [MAIL]: {
          maxMailboxesPerEmail: 1,
          maxMailboxDepth: null,
          maxSizeMailboxName: 120,
          maxSizeAttachmentsPerEmail: config.maxMessageBytes,
          emailQuerySortOptions: ["receivedAt"],
          mayCreateTopLevelMailbox: true,
        },
        [SUBMISSION]: {
          maxDelayedSend: 0,
          submissionExtensions: {},
        },
      },
      accounts: {
        [accountId]: {
          name: identity.email,
          isPersonal: true,
          isReadOnly: false,
          accountCapabilities: { [CORE]: {}, [MAIL]: {}, [SUBMISSION]: {} },
        },
      },
      primaryAccounts: { [CORE]: accountId, [MAIL]: accountId, [SUBMISSION]: accountId },
      username: identity.email,
      apiUrl: `${base}/jmap`,
      downloadUrl: `${base}/jmap/download/{accountId}/{blobId}/{name}?accept={type}`,
      uploadUrl: `${base}/jmap/upload/{accountId}/`,
      eventSourceUrl: `${base}/jmap/eventsource`,
      state: await accountState(accountId),
    })
  }),

  post("/jmap", async (c) => {
    const identity = await authenticate(c)
    if (!identity) return unauthorized(c as never)

    let request: { using?: string[]; methodCalls?: MethodCall[] }
    try {
      request = (await c.request.json()) as typeof request
    } catch {
      return json(c, 400, { type: "urn:ietf:params:jmap:error:notJSON" })
    }

    const calls = request.methodCalls ?? []
    if (calls.length > 32) {
      return json(c, 400, { type: "urn:ietf:params:jmap:error:limit", limit: "maxCallsInRequest" })
    }

    const ctx: Ctx = { identity, accountId: identity.address.id }
    const responses: MethodCall[] = []

    for (const [name, rawArgs, callId] of calls) {
      const args = { ...rawArgs, ...resolveReferences(rawArgs ?? {}, responses) }
      try {
        const [responseName, result] = await invoke(name, args, ctx)
        responses.push([responseName, result as Record<string, any>, callId])
      } catch (e) {
        // One failed method must not fail the batch — the client needs the
        // results of the calls that did work.
        console.error(`[corsair] jmap ${name} failed:`, e)
        responses.push(["error", { type: "serverFail" }, callId])
      }
    }

    return json(c, 200, {
      methodResponses: responses,
      sessionState: await accountState(ctx.accountId),
    })
  }),

  /** Blob download. The blob id is either a message id or `<message>:<section>`. */
  get("/jmap/download/:accountId/:blobId/:name", async (c) => {
    const identity = await authenticate(c)
    if (!identity) return unauthorized(c as never)

    const [messageId, section] = String(c.params.blobId).split(":")
    const message = await db().one<Message>(
      from(messages).where((q) => [
        q("id").equals(String(messageId)),
        q("address_id").equals(identity.address.id),
        q("expunged_at").isNull(),
      ]),
    )
    if (!message) return json(c, 404, { type: "urn:ietf:params:jmap:error:notFound" })

    const raw = await getRaw({ storageKey: message.storage_key, messageId: message.id })
    if (!raw) return json(c, 404, { type: "urn:ietf:params:jmap:error:notFound" })

    if (!section) {
      const response = text(c, 200, raw)
      return {
        ...response,
        respHeaders: new Headers([
          ...response.respHeaders,
          ["content-type", "message/rfc822"],
          ["x-content-type-options", "nosniff"],
        ]),
      }
    }

    const parsed = mime.parseMessage(raw)
    const part = mime.findPart(parsed, section)
    if (!part) return json(c, 404, { type: "urn:ietf:params:jmap:error:notFound" })

    const bytes = mime.decodeTransfer(raw.slice(part.bodyStart, part.end), part.encoding)
    return new Response(new Uint8Array(bytes), {
      headers: {
        // Never the declared type: serving an attacker-supplied text/html blob
        // inline on this origin would hand it the session.
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${mime.stripControls(String(c.params.name)).replace(/"/g, "")}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
      },
    }) as never
  }),

  /** Blob upload, which is how a client composes a message with attachments. */
  post("/jmap/upload/:accountId", async (c) => {
    const identity = await authenticate(c)
    if (!identity) return unauthorized(c as never)

    const body = await c.request.arrayBuffer()
    if (body.byteLength > config.maxMessageBytes) {
      return json(c, 400, { type: "urn:ietf:params:jmap:error:limit", limit: "maxSizeUpload" })
    }

    // An uploaded blob is a draft message, stored in Drafts where it is already
    // subject to the account's quota and retention rather than in a second
    // holding area with its own lifecycle.
    const { folderBySpecialUse } = await import("../../../addresses/index.ts")
    const drafts = await folderBySpecialUse(identity.address.id, "drafts")
    if (!drafts) return json(c, 404, { type: "urn:ietf:params:jmap:error:notFound" })

    const raw = Buffer.from(body).toString("latin1")
    const stored = await deliver({
      addressId: identity.address.id,
      folderId: drafts.id,
      raw: raw.includes("\r\n\r\n")
        ? raw
        : // Not a message — wrap it so the store's invariants still hold.
          `Content-Type: application/octet-stream\r\nMessage-ID: ${rfcMessageId(identity.domain.name)}\r\n\r\n${raw}`,
      flags: ["\\Draft", "\\Seen"],
    })

    return json(c, 201, {
      accountId: identity.address.id,
      blobId: stored.id,
      type: c.headers.get("content-type") ?? "application/octet-stream",
      size: body.byteLength,
    })
  }),
]
