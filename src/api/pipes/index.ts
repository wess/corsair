import { from } from "@atlas/db"
import { clientIp, createDbRateLimit, parseTrustedProxies } from "@atlas/security"
import { assign, type Conn, isHttpError, json, type PipeFn, type Route } from "@atlas/server"
import { type ResolvedAgent, resolveAgent } from "../../agents/index.ts"
import { type Permission, resolveApiKey } from "../../apikeys/index.ts"
import {
  type MailIdentity,
  type Principal,
  requireMailIdentity,
  requirePrincipal,
  resolveSession,
} from "../../auth/index.ts"
import { config } from "../../config/index.ts"
import { db } from "../../db/index.ts"
import {
  applicationError,
  errorBody,
  forbidden,
  invalidApiKey,
  missingApiKey,
  rateLimitExceeded,
  restrictedApiKey,
} from "../../errors/index.ts"
import { type Entitlement, entitlementOf } from "../../plans/index.ts"
import { users } from "../../schema/index.ts"
import type { Sender } from "../../sending/index.ts"

const trustedProxies = parseTrustedProxies(config.trustedProxies)

export const ipOf = (conn: Conn): string => clientIp(conn.request, { trustedProxies }) ?? "unknown"

// errors

/**
 * Constraint violations are caller errors, not server faults. Without this they
 * surface as 500s, which is both wrong and unhelpful to whoever has to act on
 * the response.
 */
const fromPostgres = (err: unknown): { status: number; name: string; message: string } | null => {
  const e = err as { errno?: string; code?: string; constraint?: string }
  const sqlstate = e?.errno ?? e?.code
  const subject = e?.constraint ? ` (${e.constraint})` : ""
  switch (sqlstate) {
    case "23505":
      return {
        status: 409,
        name: "conflict",
        message: `A record with these values already exists${subject}.`,
      }
    case "23503":
      return {
        status: 422,
        name: "invalid_parameter",
        message: "A referenced record does not exist.",
      }
    case "23502":
      return {
        status: 422,
        name: "missing_required_field",
        message: "A required field is missing.",
      }
    case "22P02":
    case "22001":
      return {
        status: 400,
        name: "invalid_parameter",
        message: "A parameter has an invalid value.",
      }
    default:
      return null
  }
}

export const renderError = (conn: Conn, err: unknown): Conn => {
  if (isHttpError(err)) {
    let next = json(conn, err.status, errorBody(err))
    for (const [k, v] of Object.entries(err.headers ?? {})) {
      next = { ...next, respHeaders: new Headers([...next.respHeaders, [k, v]]) }
    }
    return next
  }

  const maybe = err as { code?: string; message?: string }
  if (maybe?.code === "VALIDATION_FAILED") {
    return json(conn, 422, {
      statusCode: 422,
      name: "validation_error",
      message: maybe.message ?? "Invalid request payload.",
    })
  }

  const pg = fromPostgres(err)
  if (pg)
    return json(conn, pg.status, { statusCode: pg.status, name: pg.name, message: pg.message })

  console.error("[corsair] unhandled route error:", err)
  return json(conn, 500, errorBody(applicationError()))
}

// pipes

export const auth: PipeFn = async (conn) => {
  const principal = await requirePrincipal(conn.headers.get("cookie"))
  return assign(conn, { principal })
}

/**
 * The entitlement is resolved once per request and attached, so a handler that
 * needs both a feature check and the plan's limits does not query twice.
 */
export const withPlan: PipeFn = async (conn) => {
  const principal = (conn.assigns as { principal: Principal }).principal
  const entitlement = await entitlementOf(principal.userId)
  return assign(conn, { entitlement })
}

const limiter = createDbRateLimit({ db: db() })

export const rateLimit: PipeFn = async (conn) => {
  const principal = (conn.assigns as { principal?: Principal }).principal
  const bucket = principal ? `api:user:${principal.userId}` : `api:ip:${ipOf(conn)}`
  const { ok, retryAfterSeconds } = await limiter.check(bucket, config.rateLimitPerSecond, 1)
  if (!ok) throw rateLimitExceeded(retryAfterSeconds ?? 1, config.rateLimitPerSecond)
  return conn
}

/** Sign-in and sign-up are rate limited by IP, since there is no principal yet. */
export const publicLimit: PipeFn = async (conn) => {
  const { ok, retryAfterSeconds } = await limiter.check(`auth:ip:${ipOf(conn)}`, 5, 1)
  if (!ok) throw rateLimitExceeded(retryAfterSeconds ?? 1, 5)
  return conn
}

/**
 * The instance owner, and nobody else.
 *
 * Not a role or a permission bit — the single account that claimed the server
 * on first signup. Anything behind this sees across every account on the box,
 * so the check is a database read of `is_owner` on each request rather than
 * anything carried in the session, which would survive the flag being cleared.
 */
export const owner: PipeFn = async (conn) => {
  const principal = (conn.assigns as { principal: Principal }).principal
  const row = await db().one<{ is_owner: boolean }>(
    from(users)
      .select("is_owner")
      .where((q) => q("id").equals(principal.userId)),
  )
  if (!row?.is_owner) throw forbidden("Only the owner of this server can do that.")
  return conn
}

/**
 * A *mailbox* session, not a panel one.
 *
 * Deliberately a different claim from `authed`: the two identities are separate
 * everywhere in this codebase, and anything behind this has proved possession
 * of a mailbox credential only. It lives here rather than in the webmail routes
 * because the delegated management surface needs the same pipe and neither
 * module should own the other's.
 */
const mailAuth: PipeFn = async (conn) => {
  const identity = await requireMailIdentity(conn.headers.get("cookie"))
  return assign(conn, { identity })
}

export const mailed: readonly PipeFn[] = [mailAuth]

export const identityOf = (conn: { assigns: unknown }): MailIdentity =>
  (conn.assigns as { identity: MailIdentity }).identity

export const authed: readonly PipeFn[] = [auth, rateLimit]
export const authedWithPlan: readonly PipeFn[] = [auth, rateLimit, withPlan]
export const ownerOnly: readonly PipeFn[] = [auth, rateLimit, owner]

export const principalOf = (conn: { assigns: unknown }): Principal =>
  (conn.assigns as { principal: Principal }).principal

export const entitlementFrom = (conn: { assigns: unknown }): Entitlement =>
  (conn.assigns as { entitlement: Entitlement }).entitlement

// sending

/**
 * The bearer token on a sending-API request, resolved to the account it sends
 * for. A header that is present but wrong is refused outright — it never falls
 * through to the session, so a revoked key cannot keep working in a browser
 * that happens to be signed in.
 */
const bearer = async (conn: Conn): Promise<Sender | null> => {
  const header = conn.headers.get("authorization")
  if (!header) return null
  const match = header.match(/^Bearer\s+(\S+)$/i)
  const key = match ? await resolveApiKey(match[1]!) : null
  if (!key) throw invalidApiKey()
  return {
    userId: key.user_id,
    keyId: key.id,
    permission: key.permission as Permission,
    domainId: key.domain_id,
  }
}

/** Sending itself takes a key. The panel has no business sending as an application. */
const keyAuth: PipeFn = async (conn) => {
  const sender = await bearer(conn)
  if (!sender) throw missingApiKey()
  return assign(conn, { sender })
}

/** Reading, canceling, and rescheduling also accept the panel's session. */
const keyOrSession: PipeFn = async (conn) => {
  const sender = await bearer(conn)
  if (sender) return assign(conn, { sender })

  const principal = await resolveSession(conn.headers.get("cookie"))
  if (!principal) throw missingApiKey()
  return assign(conn, {
    sender: {
      userId: principal.userId,
      keyId: null,
      permission: "full_access",
      domainId: null,
    } satisfies Sender,
  })
}

const senderLimit: PipeFn = async (conn) => {
  const { sender } = conn.assigns as { sender: Sender }
  const { ok, retryAfterSeconds } = await limiter.check(
    `api:user:${sender.userId}`,
    config.rateLimitPerSecond,
    1,
  )
  if (!ok) throw rateLimitExceeded(retryAfterSeconds ?? 1, config.rateLimitPerSecond)
  return conn
}

const fullAccess: PipeFn = async (conn) => {
  if ((conn.assigns as { sender: Sender }).sender.permission !== "full_access") {
    throw restrictedApiKey()
  }
  return conn
}

export const sending: readonly PipeFn[] = [keyAuth, senderLimit]
export const sendingFull: readonly PipeFn[] = [keyOrSession, senderLimit, fullAccess]

export const senderOf = (conn: { assigns: unknown }): Sender =>
  (conn.assigns as { sender: Sender }).sender

// agents

/**
 * An agent's token, resolved to its one mailbox.
 *
 * Its own pipe rather than a mode of `bearer`: an agent token must not be
 * accepted by anything that sends, and a sending key must not read an inbox.
 * The two prefixes differ and so do the lookups, so neither can stand in for
 * the other. Limited per agent, because the account's bucket is shared with
 * everything else it does.
 */
/**
 * Two ways to present the same token: `Bearer ca_…`, or HTTP Basic with the
 * agent's address as the username and the token as the password — which is what
 * a mail client, `curl -u`, or any HTTP library's "username and password" field
 * already does. With Basic the address has to be the one the token belongs to,
 * so a mistyped or swapped address fails here instead of quietly working.
 */
const agentCredential = (header: string): { token: string; email: string | null } | null => {
  const bearer = header.match(/^Bearer\s+(\S+)$/i)
  if (bearer) return { token: bearer[1]!, email: null }

  const basic = header.match(/^Basic\s+(\S+)$/i)
  if (!basic) return null
  const decoded = Buffer.from(basic[1]!, "base64").toString("utf8")
  const colon = decoded.indexOf(":")
  if (colon <= 0) return null
  return { token: decoded.slice(colon + 1), email: decoded.slice(0, colon).trim().toLowerCase() }
}

/**
 * Failed token attempts per IP, in memory.
 *
 * A bad token cannot be brute-forced (256 bits), but each one still costs a
 * database lookup before it can be refused, and the shared per-second limiter
 * only sees authenticated callers. So *failures* are counted, and an address that
 * keeps failing is turned away before the lookup. Successful requests are not
 * counted, which is why this is not `publicLimit`: agents polling from one NAT
 * must not share a five-a-second budget. In memory because the thing being
 * protected is the database; a restart forgetting the counts costs nothing.
 */
const BAD_TOKEN_LIMIT = 30
const BAD_TOKEN_WINDOW_MS = 60_000
const badTokens = new Map<string, { count: number; resetAt: number }>()

const tooManyBadTokens = (ip: string): boolean => {
  const entry = badTokens.get(ip)
  if (!entry) return false
  if (entry.resetAt < Date.now()) {
    badTokens.delete(ip)
    return false
  }
  return entry.count >= BAD_TOKEN_LIMIT
}

const noteBadToken = (ip: string): void => {
  const now = Date.now()
  // Bounded: a flood from many addresses must not grow this without limit.
  if (badTokens.size > 10_000) {
    for (const [key, value] of badTokens) if (value.resetAt < now) badTokens.delete(key)
    if (badTokens.size > 10_000) badTokens.clear()
  }
  const entry = badTokens.get(ip)
  if (!entry || entry.resetAt < now) {
    badTokens.set(ip, { count: 1, resetAt: now + BAD_TOKEN_WINDOW_MS })
  } else {
    entry.count++
  }
}

const agentAuth: PipeFn = async (conn) => {
  const header = conn.headers.get("authorization")
  if (!header) throw missingApiKey()

  const ip = ipOf(conn)
  if (tooManyBadTokens(ip)) throw rateLimitExceeded(BAD_TOKEN_WINDOW_MS / 1000, BAD_TOKEN_LIMIT)

  const credential = agentCredential(header)
  const resolved = credential ? await resolveAgent(credential.token) : null
  if (
    !credential ||
    !resolved ||
    (credential.email !== null &&
      credential.email !== `${resolved.address.local_part}@${resolved.domain.name}`.toLowerCase())
  ) {
    noteBadToken(ip)
    throw invalidApiKey()
  }

  const { ok, retryAfterSeconds } = await limiter.check(
    `api:agent:${resolved.agent.id}`,
    config.rateLimitPerSecond,
    1,
  )
  if (!ok) throw rateLimitExceeded(retryAfterSeconds ?? 1, config.rateLimitPerSecond)
  return assign(conn, { agent: resolved })
}

export const agentOnly: readonly PipeFn[] = [agentAuth]

export const agentOf = (conn: { assigns: unknown }): ResolvedAgent =>
  (conn.assigns as { agent: ResolvedAgent }).agent

// wrapping

/**
 * Renders thrown errors into the API envelope. The router's own catch never
 * fires because the error is resolved into a Conn here.
 */
export const wrap = (handler: PipeFn): PipeFn => {
  return async (conn) => {
    try {
      return await handler(conn)
    } catch (err) {
      return renderError(conn, err)
    }
  }
}

export const wrapAll = (routes: readonly Route[]): Route[] =>
  routes.map((r) => ({ ...r, handler: wrap(r.handler) }))
