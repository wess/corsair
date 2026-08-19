import { from } from "@atlas/db"
import { assign, delR, getR, json, type PipeFn, postR, type Route, text } from "@atlas/server"
import { z } from "zod"
import { folderBySpecialUse, ownerOfDomain, setPassword } from "../../../addresses/index.ts"
import {
  authenticateAddress,
  clearedMailCookie,
  issueMailSession,
  type MailIdentity,
  mailCookie,
  requireMailIdentity,
  verifyMailboxPassword,
} from "../../../auth/index.ts"
import { config } from "../../../config/index.ts"
import { allColumns, db, num } from "../../../db/index.ts"
import { sign } from "../../../dkim/index.ts"
import { activeDkimKey } from "../../../domains/index.ts"
import { invalidParameter, notFound, unauthorized } from "../../../errors/index.ts"
import { rfcMessageId, uidValidity } from "../../../ids/index.ts"
import * as mime from "../../../mime/index.ts"
import { enqueue } from "../../../outbound/index.ts"
import { withinDailyLimit } from "../../../plans/index.ts"
import { sanitizeHtml, textToHtml } from "../../../sanitize/index.ts"
import {
  type Address,
  addresses,
  type Folder,
  folders,
  type Message,
  mailLog,
  messages,
} from "../../../schema/index.ts"
import { getRaw } from "../../../storage/index.ts"
import { deliver, expunge, moveTo, setFlags } from "../../../store/index.ts"
import { ipOf, publicLimit } from "../../pipes/index.ts"

/**
 * The webmail API.
 *
 * Authenticated by a mailbox credential, not a control-panel one, and scoped to
 * exactly one address — every query below filters on `identity.address.id`, so
 * there is no request shape that can reach another mailbox's mail.
 */

const mailAuth: PipeFn = async (conn) => {
  const identity = await requireMailIdentity(conn.headers.get("cookie"))
  return assign(conn, { identity })
}

const mailed: readonly PipeFn[] = [mailAuth]

const identityOf = (conn: { assigns: unknown }): MailIdentity =>
  (conn.assigns as { identity: MailIdentity }).identity

const ownedMessage = async (identity: MailIdentity, id: string): Promise<Message> => {
  const row = await db().one<Message>(
    from(messages).where((q) => [
      q("id").equals(id),
      q("address_id").equals(identity.address.id),
      q("expunged_at").isNull(),
    ]),
  )
  if (!row) throw notFound("Message not found.")
  return row
}

const ownedFolder = async (identity: MailIdentity, id: string): Promise<Folder> => {
  const row = await db().one<Folder>(
    from(folders).where((q) => [q("id").equals(id), q("address_id").equals(identity.address.id)]),
  )
  if (!row) throw notFound("Folder not found.")
  return row
}

const summary = (message: Message) => ({
  id: message.id,
  uid: num(message.uid),
  folder_id: message.folder_id,
  subject: message.subject,
  from: message.from_address,
  to: message.to_addresses ?? [],
  snippet: message.snippet,
  flags: message.flags ?? [],
  seen: (message.flags ?? []).some((f) => f.toLowerCase() === "\\seen"),
  flagged: (message.flags ?? []).some((f) => f.toLowerCase() === "\\flagged"),
  answered: (message.flags ?? []).some((f) => f.toLowerCase() === "\\answered"),
  draft: (message.flags ?? []).some((f) => f.toLowerCase() === "\\draft"),
  size: message.size,
  has_attachments: message.has_attachments,
  date: message.internal_date.toISOString(),
})

export const webmailRoutes: Route[] = [
  // ------------------------------------------------------------------ auth --

  postR(
    "/api/mail/login",
    {
      body: z.object({ email: z.string().max(320), password: z.string().max(200) }),
      before: [publicLimit],
      assigns: {} as never,
    },
    async (c) => {
      const identity = await authenticateAddress(c.body.email.trim(), c.body.password)
      if (!identity) {
        const { recordAuthFailure } = await import("../../../auth/index.ts")
        await recordAuthFailure(ipOf(c as never), "webmail", c.body.email).catch(() => {})
        throw unauthorized("Those credentials are not valid.")
      }

      const session = await issueMailSession(identity.address.id)
      const response = json(c, 200, {
        object: "mail_session",
        email: identity.email,
        name: identity.address.name,
      })
      return {
        ...response,
        respHeaders: new Headers([...response.respHeaders, ["set-cookie", mailCookie(session)]]),
      }
    },
  ),

  postR("/api/mail/logout", { before: [], assigns: {} as never }, async (c) => {
    const response = json(c, 200, { object: "mail_session", ok: true })
    return {
      ...response,
      respHeaders: new Headers([...response.respHeaders, ["set-cookie", clearedMailCookie()]]),
    }
  }),

  /**
   * Changes the signed-in mailbox's own password.
   *
   * Not gated on `domains.self_service_enabled`, which the unauthenticated
   * recovery flow does check. That flag guards mailing a reset link to a third
   * party — an account-takeover surface the domain owner should be able to
   * switch off. Somebody who has just proved possession of the current password
   * is not being granted anything they did not already hold, and a mailbox user
   * with no way to rotate a credential they believe is compromised is worse off
   * than one who can.
   *
   * `setPassword` refuses a mailbox whose credential is the owner's account
   * password, so the linked case cannot be written through from here.
   */
  postR(
    "/api/mail/password",
    {
      body: z.object({
        current_password: z.string().max(200),
        new_password: z.string().min(8).max(200),
      }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)

      if (!(await verifyMailboxPassword(identity.address, c.body.current_password))) {
        // Counted like a failed login: this endpoint takes a password guess, so
        // leaving it out of the ban logic would make it the cheap way to try.
        const { recordAuthFailure } = await import("../../../auth/index.ts")
        await recordAuthFailure(ipOf(c as never), "webmail", identity.email).catch(() => {})
        throw unauthorized("That is not your current password.")
      }

      if (c.body.current_password === c.body.new_password) {
        throw invalidParameter("That is already your password.")
      }

      await setPassword(identity.address.id, c.body.new_password)

      /**
       * Other sessions survive this. A webmail session is a signed JWT with no
       * server-side record, so there is nothing to revoke — `password_changed_at`
       * is written but never read back on the session path. Anyone already
       * signed in elsewhere stays signed in for up to `MAIL_SESSION_TTL_SECONDS`,
       * and IMAP or SMTP clients keep working until they next authenticate.
       */
      return json(c, 200, { object: "mail_password", changed: true })
    },
  ),

  /**
   * Where this mailbox's own recovery link is sent.
   *
   * The owner can already set this from the panel, and until now that was the
   * only way — which made "forgot your mailbox password?" a link the mailbox
   * holder could not make work for themselves. Setting it here is what turns
   * the recovery flow into something that does not route through the operator.
   *
   * The current password is required, and that is not ceremony. Whoever can
   * change this address can afterwards mail themselves a password reset for
   * this mailbox, so an unattended signed-in session would otherwise be a
   * complete account takeover rather than a read of today's mail.
   */
  postR(
    "/api/mail/recovery",
    {
      body: z.object({
        current_password: z.string().max(200),
        recovery_address: z.string().email().max(320).nullable(),
      }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)

      if (!(await verifyMailboxPassword(identity.address, c.body.current_password))) {
        const { recordAuthFailure } = await import("../../../auth/index.ts")
        await recordAuthFailure(ipOf(c as never), "webmail", identity.email).catch(() => {})
        throw unauthorized("That is not your current password.")
      }

      const next = c.body.recovery_address?.trim().toLowerCase() ?? null
      // A link sent to the mailbox you cannot get into is no help. The panel
      // route refuses the same thing; both have to, because either can set it.
      if (next && next === identity.email.toLowerCase()) {
        throw invalidParameter(
          "Use a different mailbox — a recovery link sent here is no use if you cannot sign in.",
        )
      }

      const saved = await db().one<Address>(
        from(addresses)
          .where((q) => q("id").equals(identity.address.id))
          .update({ recovery_address: next, updated_at: new Date() })
          .returning(...allColumns(addresses)),
      )
      return json(c, 200, {
        object: "mail_recovery",
        recovery_address: saved?.recovery_address ?? null,
      })
    },
  ),

  getR("/api/mail/me", { before: mailed, assigns: {} as never }, async (c) => {
    const identity = identityOf(c)
    return json(c, 200, {
      object: "mailbox",
      email: identity.email,
      name: identity.address.name,
      domain: identity.domain.name,
      quota_bytes: num(identity.address.bytes_used),
      recovery_address: identity.address.recovery_address,
      // Whether a recovery link would actually be sent for this mailbox. Both
      // halves have to be true, and only one of them is the mailbox holder's to
      // set — so the settings panel can say which half is missing instead of
      // offering a reset that silently goes nowhere.
      recovery_enabled: identity.domain.self_service_enabled,
      smtp: { host: config.mail.smtp, port: 587 },
    })
  }),

  // --------------------------------------------------------------- folders --

  getR("/api/mail/folders", { before: mailed, assigns: {} as never }, async (c) => {
    const rows = await db().all<{
      id: string
      name: string
      special_use: string | null
      total: string
      unseen: string
    }>({
      text: `SELECT f.id, f.name, f.special_use,
                    count(m.id) FILTER (WHERE m.expunged_at IS NULL)::text AS total,
                    count(m.id) FILTER (WHERE m.expunged_at IS NULL
                      AND NOT (m.flags @> '["\\\\Seen"]'::jsonb))::text AS unseen
               FROM folders f LEFT JOIN messages m ON m.folder_id = f.id
              WHERE f.address_id = $1
              GROUP BY f.id
              ORDER BY
                -- Inbox first, then the other special-use folders, then the
                -- customer's own, alphabetically. Sorting purely by name puts
                -- Archive above Inbox, which no mail client does.
                CASE f.special_use
                  WHEN 'inbox' THEN 0 WHEN 'drafts' THEN 1 WHEN 'sent' THEN 2
                  WHEN 'junk' THEN 3 WHEN 'trash' THEN 4 WHEN 'archive' THEN 5
                  ELSE 6 END,
                f.name`,
      values: [identityOf(c).address.id],
    })

    return json(c, 200, {
      object: "list",
      data: rows.map((r) => ({
        id: r.id,
        name: r.name,
        special_use: r.special_use,
        total: Number(r.total),
        unseen: Number(r.unseen),
      })),
    })
  }),

  postR(
    "/api/mail/folders",
    {
      body: z.object({ name: z.string().min(1).max(120) }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)
      const name = c.body.name.trim().replace(/^\/+|\/+$/g, "")
      if (!name) throw invalidParameter("A folder needs a name.")

      const existing = await db().one<{ id: string }>(
        from(folders)
          .select("id")
          .where((q) => [q("address_id").equals(identity.address.id), q("name").equals(name)]),
      )
      if (existing) throw invalidParameter("A folder with that name already exists.")

      const row = await db().one<Pick<Folder, "id" | "name" | "special_use">>(
        from(folders)
          .insert({ address_id: identity.address.id, name, uid_validity: uidValidity() })
          .returning("id", "name", "special_use"),
      )
      return json(c, 201, { object: "folder", ...row })
    },
  ),

  delR(
    "/api/mail/folders/:folder_id",
    {
      params: z.object({ folder_id: z.string().uuid() }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const folder = await ownedFolder(identityOf(c), c.params.folder_id)
      if (folder.special_use) {
        throw invalidParameter(`${folder.name} is a system folder and cannot be deleted.`)
      }
      await db().execute(
        from(folders)
          .where((q) => q("id").equals(folder.id))
          .del(),
      )
      return json(c, 200, { object: "folder", id: folder.id, deleted: true })
    },
  ),

  // -------------------------------------------------------------- messages --

  getR(
    "/api/mail/messages",
    {
      query: z.record(z.string()).optional(),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)
      const query = (c.query ?? {}) as Record<string, string>
      const page = Math.max(1, Number(query.page ?? "1") || 1)
      const perPage = Math.min(100, Math.max(10, Number(query.per_page ?? "50") || 50))
      const search = (query.search ?? "").trim()

      const values: unknown[] = [identity.address.id]
      let where = "m.address_id = $1 AND m.expunged_at IS NULL"

      if (query.folder_id) {
        values.push(query.folder_id)
        where += ` AND m.folder_id = $${values.length}`
      }
      if (query.unseen === "true") {
        where += ` AND NOT (m.flags @> '["\\\\Seen"]'::jsonb)`
      }
      if (query.flagged === "true") {
        where += ` AND m.flags @> '["\\\\Flagged"]'::jsonb`
      }
      if (search) {
        values.push(`%${search}%`)
        const p = `$${values.length}`
        // The indexed extract already holds the decoded body plus the
        // searchable headers, so this never reads an object from storage.
        where += ` AND (m.subject ILIKE ${p} OR m.from_address ILIKE ${p} OR m.search_text ILIKE ${p})`
      }

      const total = await db().one<{ count: string }>({
        text: `SELECT count(*)::text AS count FROM messages m WHERE ${where}`,
        values,
      })

      const rows = await db().all<Message>({
        text: `SELECT * FROM messages m WHERE ${where}
                ORDER BY m.internal_date DESC
                LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`,
        values,
      })

      return json(c, 200, {
        object: "list",
        data: rows.map(summary),
        page,
        per_page: perPage,
        total: Number(total?.count ?? 0),
        pages: Math.max(1, Math.ceil(Number(total?.count ?? 0) / perPage)),
      })
    },
  ),

  getR(
    "/api/mail/messages/:message_id",
    {
      params: z.object({ message_id: z.string().uuid() }),
      query: z.record(z.string()).optional(),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)
      const message = await ownedMessage(identity, c.params.message_id)
      const raw = await getRaw({ storageKey: message.storage_key, messageId: message.id })
      if (!raw) throw notFound("This message's body is no longer available.")

      const parsed = mime.parseMessage(raw)
      const bodies = mime.bodyText(raw, parsed)
      const allowRemote = ((c.query ?? {}) as Record<string, string>).images === "true"

      // Inline parts are addressed by their section so the reader can fetch one
      // without the server holding any per-request state.
      const inline = new Map<string, string>()
      mime.walk(parsed.root, (part) => {
        const id = part.id?.replace(/^<|>$/g, "")
        if (id) inline.set(id, part.section)
      })

      const rendered = bodies.html
        ? sanitizeHtml(bodies.html, {
            allowRemoteImages: allowRemote,
            resolveCid: (cid) => {
              const section = inline.get(cid.replace(/^<|>$/g, ""))
              return section ? `/api/mail/messages/${message.id}/part/${section}` : null
            },
          })
        : { html: textToHtml(bodies.text), blockedRemoteImages: false }

      // Mark read on open, which is what every mail client does.
      if (!(message.flags ?? []).some((f) => f.toLowerCase() === "\\seen")) {
        await setFlags(message.id, message.folder_id, [...(message.flags ?? []), "\\Seen"])
      }

      return json(c, 200, {
        object: "message",
        ...summary(message),
        headers: {
          from: mime.decodeWords(mime.headerValue(parsed.headers, "from") ?? ""),
          to: mime.decodeWords(mime.headerValue(parsed.headers, "to") ?? ""),
          cc: mime.decodeWords(mime.headerValue(parsed.headers, "cc") ?? ""),
          reply_to: mime.decodeWords(mime.headerValue(parsed.headers, "reply-to") ?? ""),
          date: mime.headerValue(parsed.headers, "date"),
          message_id: mime.headerValue(parsed.headers, "message-id"),
        },
        body_html: rendered.html,
        body_text: bodies.text,
        blocked_remote_images: rendered.blockedRemoteImages,
        // The authentication verdict is stamped in at delivery; showing it is
        // the difference between a reader spotting a forgery and not.
        authentication: mime.headerValue(parsed.headers, "authentication-results"),
        attachments: mime.attachmentParts(parsed).map((part) => ({
          section: part.section,
          filename: part.disposition?.params.filename ?? part.params.name ?? `part-${part.section}`,
          content_type: `${part.type}/${part.subtype}`,
          size: part.size,
          inline: part.disposition?.type === "inline",
        })),
      })
    },
  ),

  /** One MIME part, for attachment download and inline images. */
  getR(
    "/api/mail/messages/:message_id/part/:section",
    {
      params: z.object({
        message_id: z.string().uuid(),
        section: z.string().regex(/^[\d.]+$/),
      }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const message = await ownedMessage(identityOf(c), c.params.message_id)
      const raw = await getRaw({ storageKey: message.storage_key, messageId: message.id })
      if (!raw) throw notFound("This message's body is no longer available.")

      const parsed = mime.parseMessage(raw)
      const part = mime.findPart(parsed, c.params.section)
      if (!part) throw notFound("No such part.")

      const bytes = mime.decodeTransfer(raw.slice(part.bodyStart, part.end), part.encoding)
      const filename =
        part.disposition?.params.filename ?? part.params.name ?? `part-${part.section}`

      // Copied into a fresh Uint8Array: a Buffer view can share a larger
      // ArrayBuffer, and Response would then serve the neighbouring bytes.
      return new Response(new Uint8Array(bytes), {
        headers: {
          // The declared type is not trusted for rendering. Serving an
          // attacker-supplied text/html attachment inline on this origin would
          // hand it the session cookie.
          "content-type":
            part.type === "image" ? `${part.type}/${part.subtype}` : "application/octet-stream",
          "content-disposition": `${part.disposition?.type === "inline" && part.type === "image" ? "inline" : "attachment"}; filename="${mime.stripControls(filename).replace(/"/g, "")}"`,
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
        },
      }) as never
    },
  ),

  postR(
    "/api/mail/messages/flags",
    {
      body: z.object({
        ids: z.array(z.string().uuid()).min(1).max(500),
        add: z.array(z.string().max(64)).optional(),
        remove: z.array(z.string().max(64)).optional(),
      }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)
      let changed = 0
      for (const id of c.body.ids) {
        const message = await ownedMessage(identity, id).catch(() => null)
        if (!message) continue
        const remove = new Set((c.body.remove ?? []).map((f) => f.toLowerCase()))
        const next = [
          ...new Set([
            ...(message.flags ?? []).filter((f) => !remove.has(f.toLowerCase())),
            ...(c.body.add ?? []),
          ]),
        ]
        await setFlags(message.id, message.folder_id, next)
        changed++
      }
      return json(c, 200, { object: "flags", changed })
    },
  ),

  postR(
    "/api/mail/messages/move",
    {
      body: z.object({
        ids: z.array(z.string().uuid()).min(1).max(500),
        folder_id: z.string().uuid(),
      }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)
      const target = await ownedFolder(identity, c.body.folder_id)

      // Grouped by source folder because an expunge is per folder, and a
      // selection can span several.
      const bySource = new Map<string, string[]>()
      for (const id of c.body.ids) {
        const message = await ownedMessage(identity, id).catch(() => null)
        if (!message || message.folder_id === target.id) continue
        bySource.set(message.folder_id, [...(bySource.get(message.folder_id) ?? []), message.id])
      }

      let moved = 0
      for (const [, ids] of bySource) {
        const result = await moveTo({ messageIds: ids, targetFolderId: target.id })
        moved += result.moved
      }
      return json(c, 200, { object: "move", moved })
    },
  ),

  /**
   * Delete means move to Trash, except when already in Trash, where it means
   * gone. That is what every mail client does and what a reader expects from a
   * second press of the same key.
   */
  postR(
    "/api/mail/messages/delete",
    {
      body: z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)
      const trash = await folderBySpecialUse(identity.address.id, "trash")

      const purge = new Map<string, string[]>()
      const toTrash = new Map<string, string[]>()

      for (const id of c.body.ids) {
        const message = await ownedMessage(identity, id).catch(() => null)
        if (!message) continue
        const bucket = !trash || message.folder_id === trash.id ? purge : toTrash
        bucket.set(message.folder_id, [...(bucket.get(message.folder_id) ?? []), message.id])
      }

      let deleted = 0
      for (const [, ids] of toTrash) {
        const result = await moveTo({ messageIds: ids, targetFolderId: trash!.id })
        deleted += result.moved
      }
      for (const [folderId, ids] of purge) {
        await expunge({ folderId, messageIds: ids })
        deleted += ids.length
      }

      return json(c, 200, { object: "delete", deleted, permanent: purge.size > 0 })
    },
  ),

  // ----------------------------------------------------------------- send --

  postR(
    "/api/mail/send",
    {
      body: z.object({
        to: z.array(z.string().email().max(320)).min(1).max(100),
        cc: z.array(z.string().email().max(320)).max(100).optional(),
        bcc: z.array(z.string().email().max(320)).max(100).optional(),
        subject: z.string().max(500),
        text: z.string().max(5_000_000),
        in_reply_to: z.string().max(500).nullable().optional(),
        references: z.array(z.string().max(500)).max(50).optional(),
        draft_id: z.string().uuid().nullable().optional(),
      }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)

      if (identity.domain.status !== "active") {
        throw invalidParameter(
          `${identity.domain.name} is not verified yet. Finish DNS setup before sending.`,
        )
      }

      const owner = await ownerOfDomain(identity.domain.id)
      if (owner) {
        const limit = await withinDailyLimit(owner, "outbound", identity.address.daily_out_limit)
        if (!limit.ok) {
          throw invalidParameter(
            `Daily sending limit of ${limit.limit} messages reached. Try again tomorrow.`,
          )
        }
      }

      const messageId = rfcMessageId(identity.domain.name)
      const raw = mime.buildMessage({
        from: { name: identity.address.name, address: identity.email },
        to: c.body.to.map((address) => ({ name: null, address })),
        cc: c.body.cc?.map((address) => ({ name: null, address })),
        subject: c.body.subject,
        text: c.body.text,
        messageId,
        inReplyTo: c.body.in_reply_to ?? null,
        references: c.body.references,
      })

      // Signed before anything is stored, so the copy in Sent is byte-identical
      // to what the recipient receives.
      const key = await activeDkimKey(identity.domain.id)
      const signed = key
        ? sign({
            raw,
            domain: identity.domain.name,
            selector: key.selector,
            privateKey: key.private_key,
          })
        : raw

      // Bcc recipients are in the envelope but never in the headers — that is
      // the entire point of Bcc, and putting them in a header leaks them to
      // every other recipient.
      const recipients = [...c.body.to, ...(c.body.cc ?? []), ...(c.body.bcc ?? [])]
      await enqueue({
        raw: signed,
        mailFrom: identity.email,
        recipients,
        addressId: identity.address.id,
        domainId: identity.domain.id,
      })

      const sent = await folderBySpecialUse(identity.address.id, "sent")
      if (sent) {
        await deliver({
          addressId: identity.address.id,
          folderId: sent.id,
          raw: signed,
          flags: ["\\Seen"],
        }).catch((e: unknown) => console.error("[corsair] could not file a copy in Sent:", e))
      }

      // A sent draft is no longer a draft.
      if (c.body.draft_id) {
        const draft = await ownedMessage(identity, c.body.draft_id).catch(() => null)
        if (draft) await expunge({ folderId: draft.folder_id, messageIds: [draft.id] })
      }

      for (const recipient of recipients) {
        await db()
          .execute(
            from(mailLog).insert({
              user_id: owner,
              domain_id: identity.domain.id,
              address_id: identity.address.id,
              direction: "outbound",
              status: "accepted",
              mail_from: identity.email,
              rcpt_to: recipient,
              subject: c.body.subject,
              message_id: messageId,
              size: signed.length,
              dkim: key ? "signed" : "unsigned",
              code: 250,
            }),
          )
          .catch(() => {})
      }

      return json(c, 202, { object: "message", queued: recipients.length, message_id: messageId })
    },
  ),

  postR(
    "/api/mail/drafts",
    {
      body: z.object({
        to: z.array(z.string().max(320)).max(100).optional(),
        cc: z.array(z.string().max(320)).max(100).optional(),
        subject: z.string().max(500).optional(),
        text: z.string().max(5_000_000).optional(),
        draft_id: z.string().uuid().nullable().optional(),
      }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)
      const drafts = await folderBySpecialUse(identity.address.id, "drafts")
      if (!drafts) throw notFound("This mailbox has no Drafts folder.")

      // Replaced rather than updated: the stored form is a MIME message, and
      // editing one in place means re-parsing and re-serialising it.
      if (c.body.draft_id) {
        const previous = await ownedMessage(identity, c.body.draft_id).catch(() => null)
        if (previous) await expunge({ folderId: previous.folder_id, messageIds: [previous.id] })
      }

      const raw = mime.buildMessage({
        from: { name: identity.address.name, address: identity.email },
        to: (c.body.to ?? []).filter(Boolean).map((address) => ({ name: null, address })),
        cc: (c.body.cc ?? []).filter(Boolean).map((address) => ({ name: null, address })),
        subject: c.body.subject ?? "",
        text: c.body.text ?? "",
        messageId: rfcMessageId(identity.domain.name),
      })

      const saved = await deliver({
        addressId: identity.address.id,
        folderId: drafts.id,
        raw,
        flags: ["\\Draft", "\\Seen"],
      })
      return json(c, 200, { object: "draft", id: saved.id })
    },
  ),

  /** The original, for "show source" and for saving a message to disk. */
  getR(
    "/api/mail/messages/:message_id/raw",
    {
      params: z.object({ message_id: z.string().uuid() }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const message = await ownedMessage(identityOf(c), c.params.message_id)
      const raw = await getRaw({ storageKey: message.storage_key, messageId: message.id })
      if (!raw) throw notFound("This message's body is no longer available.")
      const response = text(c, 200, raw)
      return {
        ...response,
        respHeaders: new Headers([
          ...response.respHeaders,
          ["content-type", "text/plain; charset=utf-8"],
        ]),
      }
    },
  ),
]
