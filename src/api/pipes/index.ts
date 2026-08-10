import { clientIp, createDbRateLimit, parseTrustedProxies } from "@atlas/security"
import { assign, type Conn, isHttpError, json, type PipeFn, type Route } from "@atlas/server"
import { type Principal, requirePrincipal } from "../../auth/index.ts"
import { config } from "../../config/index.ts"
import { db } from "../../db/index.ts"
import { applicationError, errorBody, rateLimitExceeded } from "../../errors/index.ts"
import { type Entitlement, entitlementOf } from "../../plans/index.ts"

const trustedProxies = parseTrustedProxies(config.trustedProxies)

export const ipOf = (conn: Conn): string => clientIp(conn.request, { trustedProxies }) ?? "unknown"

// ------------------------------------------------------------------ errors --

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

// ------------------------------------------------------------------- pipes --

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

export const authed: readonly PipeFn[] = [auth, rateLimit]
export const authedWithPlan: readonly PipeFn[] = [auth, rateLimit, withPlan]

export const principalOf = (conn: { assigns: unknown }): Principal =>
  (conn.assigns as { principal: Principal }).principal

export const entitlementFrom = (conn: { assigns: unknown }): Entitlement =>
  (conn.assigns as { entitlement: Entitlement }).entitlement

// ---------------------------------------------------------------- wrapping --

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
