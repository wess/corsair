import { randomBytes } from "node:crypto"
import { from } from "@atlas/db"
import { createAddress } from "../addresses/index.ts"
import { hashToken } from "../auth/index.ts"
import { allColumns, db } from "../db/index.ts"
import { conflict } from "../errors/index.ts"
import { type Address, type Agent, agents, type Domain } from "../schema/index.ts"

/**
 * Mailboxes for AI agents.
 *
 * An agent that signs up for a service on someone's behalf needs an address the
 * service can mail, and a way to read what arrives. The mailbox is a normal
 * `addresses` row — type `agent`, no password, so IMAP, POP3 and SMTP
 * submission refuse it (`authenticateResolved` only admits standard and
 * catch-all). What opens it is a bearer token, and that token reaches exactly
 * one thing: reading that one inbox.
 *
 * Sub-addressing already works on every mailbox, so `name+shop@domain` lands in
 * `name@domain` with the tag intact in `To`. An agent can use one tag per site
 * and see which service a message came from without any extra machinery.
 */

export const AGENT_TOKEN_PREFIX = "ca_"

export const generateAgentToken = (): string =>
  `${AGENT_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`

const credentialOf = (token: string) => ({
  token_hash: hashToken(token),
  // Enough to tell two agents apart in a list, far too little to use.
  token_prefix: token.slice(0, AGENT_TOKEN_PREFIX.length + 6),
})

/**
 * Most mail an agent mailbox may send in a rolling day, across all its
 * recipients. A cap on the mailbox, not the account: one agent in a loop must
 * not be able to spend the allowance every other mailbox shares.
 */
export const AGENT_DAILY_SENDS = 50

export const sentToday = async (addressId: string): Promise<number> => {
  const row = await db().one<{ count: string }>({
    text: `SELECT count(*)::text AS count FROM mail_log
            WHERE address_id = $1 AND direction = 'outbound'
              AND created_at > now() - interval '1 day'`,
    values: [addressId],
  })
  return Number(row?.count ?? 0)
}

export const createAgent = async (input: {
  userId: string
  domain: Domain
  name: string
  localPart?: string | null
  canSend?: boolean
}): Promise<{ agent: Agent; address: Address; token: string }> => {
  const { address } = await createAddress({
    domainId: input.domain.id,
    localPart: input.localPart || `agent-${randomBytes(4).toString("hex")}`,
    type: "agent",
    name: input.name,
  })

  const token = generateAgentToken()
  const agent = (await db().one<Agent>(
    from(agents)
      .insert({
        user_id: input.userId,
        address_id: address.id,
        name: input.name,
        can_send: input.canSend === true,
        ...credentialOf(token),
      })
      .returning(...allColumns(agents)),
  ))!
  return { agent, address, token }
}

/**
 * Replaces the token. The old one stops working the moment this commits — it is
 * the same row, so there is no window in which both are valid.
 */
export const rotateAgentToken = async (agent: Agent): Promise<{ agent: Agent; token: string }> => {
  const token = generateAgentToken()
  const updated = (await db().one<Agent>(
    from(agents)
      .where((q) => q("id").equals(agent.id))
      .update(credentialOf(token))
      .returning(...allColumns(agents)),
  ))!
  return { agent: updated, token }
}

export type ResolvedAgent = { agent: Agent; address: Address; domain: Domain }

/**
 * The agent a bearer token names, or null.
 *
 * A disabled mailbox, a deleted domain's mailbox, or a terminated account all
 * stop the token without anyone revoking it — the same rule API keys follow.
 */
export const resolveAgent = async (token: string): Promise<ResolvedAgent | null> => {
  if (!token.startsWith(AGENT_TOKEN_PREFIX)) return null

  const agent = await db().one<Agent>({
    text: `SELECT g.* FROM agents g
             JOIN users u ON u.id = g.user_id
            WHERE g.token_hash = $1 AND u.status <> 'terminated'`,
    values: [hashToken(token)],
  })
  if (!agent) return null

  const row = await db().one<Address & { domain_row: Domain }>({
    text: `SELECT a.*, to_jsonb(d) AS domain_row FROM addresses a
             JOIN domains d ON d.id = a.domain_id
            WHERE a.id = $1 AND a.disabled = false AND a.type = 'agent'`,
    values: [agent.address_id],
  })
  if (!row) return null
  const { domain_row: domain, ...address } = row

  if (!agent.last_used_at || Date.now() - agent.last_used_at.getTime() > 60_000) {
    void db()
      .execute(
        from(agents)
          .where((q) => q("id").equals(agent.id))
          .update({ last_used_at: new Date() }),
      )
      .catch(() => {})
  }
  return { agent, address: address as Address, domain }
}

export const listAgents = (
  userId: string,
): Promise<(Agent & { local_part: string; domain_name: string })[]> =>
  db().all({
    text: `SELECT g.*, a.local_part, d.name AS domain_name FROM agents g
             JOIN addresses a ON a.id = g.address_id
             JOIN domains d ON d.id = a.domain_id
            WHERE g.user_id = $1
         ORDER BY g.created_at DESC`,
    values: [userId],
  })

export const setCanSend = async (agent: Agent, canSend: boolean): Promise<Agent> =>
  (await db().one<Agent>(
    from(agents)
      .where((q) => q("id").equals(agent.id))
      .update({ can_send: canSend })
      .returning(...allColumns(agents)),
  ))!

export const findAgent = (userId: string, id: string): Promise<Agent | null> =>
  db().one<Agent>(from(agents).where((q) => [q("id").equals(id), q("user_id").equals(userId)]))

/** Refuses when the account is at its plan's address limit. */
export const assertAddressQuota = async (userId: string, max: number | null, plan: string) => {
  if (max === null) return
  const row = await db().one<{ count: string }>({
    text: `SELECT count(*)::text AS count FROM addresses a
             JOIN domains d ON d.id = a.domain_id WHERE d.user_id = $1`,
    values: [userId],
  })
  if (Number(row?.count ?? 0) >= max) {
    throw conflict(`The ${plan} plan allows ${max} address(es).`)
  }
}
