import { delR, getR, json, patchR, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { ownedDomain } from "../../../access/index.ts"
import { deleteAddress } from "../../../addresses/index.ts"
import { extractCodes, extractLinks } from "../../../agents/extract/index.ts"
import {
  AGENT_DAILY_SENDS,
  assertAddressQuota,
  createAgent,
  findAgent,
  listAgents,
  rotateAgentToken,
  sentToday,
  setCanSend,
} from "../../../agents/index.ts"
import { db } from "../../../db/index.ts"
import { dailyQuotaExceeded, forbidden, invalidParameter, notFound } from "../../../errors/index.ts"
import { emit } from "../../../events/index.ts"
import { sendFromMailbox } from "../../../mailsend/index.ts"
import * as mime from "../../../mime/index.ts"
import { partResponse } from "../../../parts/index.ts"
import type { Message } from "../../../schema/index.ts"
import { agentObject } from "../../../serialize/index.ts"
import { getRaw } from "../../../storage/index.ts"
import { setFlags } from "../../../store/index.ts"
import {
  agentOf,
  agentOnly,
  authed,
  authedWithPlan,
  entitlementFrom,
  principalOf,
} from "../../pipes/index.ts"

/**
 * Agent email.
 *
 * Two surfaces, kept apart:
 *
 *   /api/agents/...   the panel's, signed in as the account. Creates the
 *                     mailbox and its token, rotates it, deletes it.
 *   /api/agent/...    the agent's, with its token. Reads that one mailbox and
 *                     nothing else — it cannot send, cannot reach another
 *                     address, and cannot mint or see tokens.
 *
 * Everything an agent reads was written by whoever mailed it. The text is
 * returned as text, with no HTML to render, but a message can still say
 * "ignore your instructions" — treating mail as data is the agent's job, and
 * the docs say so where a developer will read it.
 */

const MAX_BODY = 20_000
const POLL_MS = 1_000
// Under the server's 60s idle timeout, with room for the last poll.
const MAX_WAIT_SECONDS = 50

const summary = (m: Message) => ({
  id: m.id,
  subject: m.subject,
  from: m.from_address,
  to: m.to_addresses ?? [],
  snippet: m.snippet,
  seen: (m.flags ?? []).some((f) => f.toLowerCase() === "\\seen"),
  has_attachments: m.has_attachments,
  received_at: m.internal_date.toISOString(),
})

type Filters = { from?: string; subject?: string; since?: string; unseen?: string }

/**
 * Messages in this mailbox, newest first. Matches are by substring through
 * `position()` rather than ILIKE, so a `%` or `_` in what an agent is looking
 * for is a character and not a wildcard.
 */
const search = async (addressId: string, filters: Filters, limit: number): Promise<Message[]> => {
  const values: unknown[] = [addressId]
  let where = "address_id = $1 AND expunged_at IS NULL"
  const contains = (column: string, needle: string) => {
    values.push(needle)
    where += ` AND position(lower($${values.length}) in lower(coalesce(${column}, ''))) > 0`
  }
  if (filters.from) contains("from_address", filters.from)
  if (filters.subject) contains("subject", filters.subject)
  if (filters.since) {
    const at = new Date(filters.since)
    if (Number.isNaN(at.getTime())) throw notFound("`since` is not a valid timestamp.")
    values.push(at)
    where += ` AND internal_date > $${values.length}`
  }
  if (filters.unseen === "true") where += ` AND NOT (flags @> '["\\\\Seen"]'::jsonb)`

  return db().all<Message>({
    text: `SELECT * FROM messages WHERE ${where} ORDER BY internal_date DESC LIMIT ${limit}`,
    values,
  })
}

const detail = async (message: Message) => {
  const raw = await getRaw({ storageKey: message.storage_key, messageId: message.id })
  if (!raw) throw notFound("This message's body is no longer available.")

  const parsed = mime.parseMessage(raw)
  const bodies = mime.bodyText(raw, parsed)
  const text = (bodies.text || mime.stripHtml(bodies.html)).replace(/[ \t]+\n/g, "\n").trim()

  if (!(message.flags ?? []).some((f) => f.toLowerCase() === "\\seen")) {
    await setFlags(message.id, message.folder_id, [...(message.flags ?? []), "\\Seen"])
  }

  return {
    object: "message" as const,
    ...summary(message),
    text: text.slice(0, MAX_BODY),
    truncated: text.length > MAX_BODY,
    // Suggestions only. The body above is the source of truth.
    links: extractLinks(bodies),
    codes: extractCodes(text),
    headers: {
      date: mime.headerValue(parsed.headers, "date"),
      message_id: mime.headerValue(parsed.headers, "message-id"),
      reply_to: mime.decodeWords(mime.headerValue(parsed.headers, "reply-to") ?? ""),
    },
    // Stamped at delivery. Whether the sender is who they claim is the one thing
    // an agent should check before acting on a link in a message.
    authentication: mime.headerValue(parsed.headers, "authentication-results"),
    attachments: mime.attachmentParts(parsed).map((part) => ({
      // Download with `GET /api/agent/messages/:id/attachments/:section`.
      section: part.section,
      filename: part.disposition?.params.filename ?? part.params.name ?? `part-${part.section}`,
      content_type: `${part.type}/${part.subtype}`,
      size: part.size,
    })),
  }
}

const ownedMessage = async (addressId: string, id: string): Promise<Message> => {
  const message = await db().one<Message>({
    text: `SELECT * FROM messages WHERE id = $1 AND address_id = $2 AND expunged_at IS NULL`,
    values: [id, addressId],
  })
  if (!message) throw notFound("Message not found.")
  return message
}

const filtersOf = (query: Record<string, string>): Filters => ({
  from: query.from?.trim() || undefined,
  subject: query.subject?.trim() || undefined,
  since: query.since,
  unseen: query.unseen,
})

const limitOf = (value: string | undefined): number =>
  Math.min(50, Math.max(1, Number(value ?? "20") || 20))

export const agentRoutes: Route[] = [
  // The panel

  getR("/api/agents", { before: authed, assigns: {} as never }, async (c) => {
    const rows = await listAgents(principalOf(c).userId)
    return json(c, 200, {
      object: "list",
      data: rows.map((row) =>
        agentObject(row, {
          email: `${row.local_part}@${row.domain_name}`,
          localPart: row.local_part,
          domain: row.domain_name,
        }),
      ),
    })
  }),

  postR(
    "/api/agents",
    {
      body: z.object({
        name: z.string().trim().min(1).max(100),
        domain_id: z.string().uuid(),
        // Optional: left out, the address is `agent-` and eight hex characters.
        local_part: z.string().trim().min(1).max(64).optional(),
        can_send: z.boolean().optional(),
      }),
      before: authedWithPlan,
      assigns: {} as never,
    },
    async (c) => {
      const userId = principalOf(c).userId
      // The owner's, not a delegate's: an agent mailbox is a credential on the
      // domain, and handing those out is the owner's call like API keys.
      const domain = await ownedDomain(userId, c.body.domain_id)
      const entitlement = entitlementFrom(c)
      await assertAddressQuota(userId, entitlement.plan.max_addresses, entitlement.plan.name)

      const { agent, address, token } = await createAgent({
        userId,
        domain,
        name: c.body.name,
        localPart: c.body.local_part,
        canSend: c.body.can_send,
      })

      void emit({
        userId,
        domainId: domain.id,
        type: "address.created",
        data: { address: `${address.local_part}@${domain.name}`, type: "agent", destinations: [] },
      })

      // The only time the token leaves this server, until it is rotated.
      return json(c, 201, {
        ...agentObject(agent, {
          email: `${address.local_part}@${domain.name}`,
          localPart: address.local_part,
          domain: domain.name,
        }),
        token,
      })
    },
  ),

  postR(
    "/api/agents/:agent_id/rotate",
    { params: z.object({ agent_id: z.string().uuid() }), before: authed, assigns: {} as never },
    async (c) => {
      const found = await findAgent(principalOf(c).userId, c.params.agent_id)
      if (!found) throw notFound("Agent not found.")
      const { agent, token } = await rotateAgentToken(found)
      const row = (await listAgents(principalOf(c).userId)).find((a) => a.id === agent.id)!
      return json(c, 200, {
        ...agentObject(agent, {
          email: `${row.local_part}@${row.domain_name}`,
          localPart: row.local_part,
          domain: row.domain_name,
        }),
        token,
      })
    },
  ),

  patchR(
    "/api/agents/:agent_id",
    {
      params: z.object({ agent_id: z.string().uuid() }),
      body: z.object({ can_send: z.boolean() }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const found = await findAgent(principalOf(c).userId, c.params.agent_id)
      if (!found) throw notFound("Agent not found.")
      const agent = await setCanSend(found, c.body.can_send)
      const row = (await listAgents(principalOf(c).userId)).find((a) => a.id === agent.id)!
      return json(
        c,
        200,
        agentObject(agent, {
          email: `${row.local_part}@${row.domain_name}`,
          localPart: row.local_part,
          domain: row.domain_name,
        }),
      )
    },
  ),

  delR(
    "/api/agents/:agent_id",
    { params: z.object({ agent_id: z.string().uuid() }), before: authed, assigns: {} as never },
    async (c) => {
      const agent = await findAgent(principalOf(c).userId, c.params.agent_id)
      if (!agent) throw notFound("Agent not found.")
      // The mailbox goes with it, and its mail. `deleteAddress` also gives the
      // space back to the domain, which the cascade alone would not.
      await deleteAddress(agent.address_id)
      return json(c, 200, { object: "agent", id: agent.id, deleted: true })
    },
  ),

  // The agent

  getR("/api/agent", { before: agentOnly, assigns: {} as never }, async (c) => {
    const { agent, address, domain } = agentOf(c)
    return json(c, 200, {
      object: "agent",
      id: agent.id,
      name: agent.name,
      email: `${address.local_part}@${domain.name}`,
    })
  }),

  getR(
    "/api/agent/messages",
    { query: z.record(z.string()).optional(), before: agentOnly, assigns: {} as never },
    async (c) => {
      const { address } = agentOf(c)
      const query = (c.query ?? {}) as Record<string, string>
      const rows = await search(address.id, filtersOf(query), limitOf(query.limit))
      return json(c, 200, { object: "list", data: rows.map(summary) })
    },
  ),

  // Ahead of `/api/agent/messages/:id` is not needed — `wait` has no `:id` — but
  // it stays above it so a future literal under messages cannot be swallowed.
  getR(
    "/api/agent/wait",
    { query: z.record(z.string()).optional(), before: agentOnly, assigns: {} as never },
    async (c) => {
      const { address } = agentOf(c)
      const query = (c.query ?? {}) as Record<string, string>
      const seconds = Math.min(MAX_WAIT_SECONDS, Math.max(1, Number(query.timeout ?? "30") || 30))
      // Without a `since`, only mail arriving *after* this call counts. Otherwise
      // an agent asking for "the verification email" would be handed last week's.
      const filters = { ...filtersOf(query), since: query.since ?? new Date().toISOString() }
      const deadline = Date.now() + seconds * 1_000

      while (true) {
        const [message] = await search(address.id, filters, 1)
        if (message) return json(c, 200, { ...(await detail(message)), matched: true })
        if (Date.now() + POLL_MS > deadline) break
        await Bun.sleep(POLL_MS)
      }
      return json(c, 200, { object: "message", matched: false })
    },
  ),

  getR(
    "/api/agent/messages/:message_id",
    {
      params: z.object({ message_id: z.string().uuid() }),
      before: agentOnly,
      assigns: {} as never,
    },
    async (c) => {
      const message = await ownedMessage(agentOf(c).address.id, c.params.message_id)
      return json(c, 200, await detail(message))
    },
  ),

  getR(
    "/api/agent/messages/:message_id/attachments/:section",
    {
      params: z.object({
        message_id: z.string().uuid(),
        section: z.string().regex(/^[\d.]+$/),
      }),
      before: agentOnly,
      assigns: {} as never,
    },
    async (c) => {
      const message = await ownedMessage(agentOf(c).address.id, c.params.message_id)
      const raw = await getRaw({ storageKey: message.storage_key, messageId: message.id })
      if (!raw) throw notFound("This message's body is no longer available.")
      // Always a download. An agent has no page to render it in, and the
      // declared type is attacker-supplied.
      return partResponse(raw, c.params.section, false) as never
    },
  ),

  postR(
    "/api/agent/send",
    {
      body: z.object({
        to: z.array(z.string().email().max(320)).max(10).optional(),
        cc: z.array(z.string().email().max(320)).max(10).optional(),
        subject: z.string().max(500).optional(),
        text: z.string().min(1).max(100_000),
        // A message in this inbox. Fills in the recipient (its sender), the
        // subject, and the threading headers, so a reply lands in the right
        // conversation on the far side.
        reply_to_message_id: z.string().uuid().optional(),
      }),
      before: agentOnly,
      assigns: {} as never,
    },
    async (c) => {
      const { agent, address, domain } = agentOf(c)
      if (!agent.can_send) {
        throw forbidden(
          "This agent can only read. Turn on sending for it in the control panel, or with PATCH /api/agents/:id.",
        )
      }

      let to = c.body.to ?? []
      let subject = c.body.subject
      let inReplyTo: string | null = null
      let references: string[] | undefined

      if (c.body.reply_to_message_id) {
        const original = await ownedMessage(address.id, c.body.reply_to_message_id)
        if (!to.length) {
          // Where the sender asked replies to go, as any mail client would. The
          // stored value is a display form ("Shop <a@b>"); only the address is
          // a recipient.
          const target = original.envelope?.reply_to[0] ?? original.from_address
          const parsed = mime.parseAddressList(target)[0]
          if (parsed) to = [parsed.address]
        }
        if (!subject && original.subject) {
          subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`
        }
        inReplyTo = original.message_id
        references = original.message_id ? [original.message_id] : undefined
      }

      if (!to.length) throw invalidParameter("Say who to send to, or reply to a message.")
      if (!subject) throw invalidParameter("A message needs a subject.")

      // Counted in recipients, because that is what the journal records, and
      // checked before sending so one call cannot step over the cap.
      const recipients = to.length + (c.body.cc?.length ?? 0)
      if ((await sentToday(address.id)) + recipients > AGENT_DAILY_SENDS) {
        throw dailyQuotaExceeded(AGENT_DAILY_SENDS)
      }

      const { queued, messageId } = await sendFromMailbox({
        address,
        domain,
        to,
        cc: c.body.cc,
        subject,
        text: c.body.text,
        inReplyTo,
        references,
      })
      return json(c, 202, { object: "message", queued, message_id: messageId })
    },
  ),
]
