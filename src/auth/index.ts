import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { hash, token, verify } from "@atlas/auth"
import { from } from "@atlas/db"
import { config } from "../config/index.ts"
import { db } from "../db/index.ts"
import { forbidden, unauthorized } from "../errors/index.ts"
import {
  type Address,
  addresses,
  authFailures,
  bans,
  type Domain,
  domains,
  sessions,
  type User,
  users,
} from "../schema/index.ts"

export const hashToken = (value: string): string => createHash("sha256").update(value).digest("hex")

// -------------------------------------------------------------- panel auth --

export const SESSION_COOKIE = "corsair_session"
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14

/** Whoever is driving the control panel. */
export type Principal = {
  userId: string
  jti: string
  isOwner: boolean
}

export const issueSession = async (
  userId: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<{ token: string; jti: string; expiresAt: Date }> => {
  const jti = randomUUID()
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000)
  await db().execute(
    from(sessions).insert({
      id: jti,
      user_id: userId,
      ip: ctx.ip ?? null,
      user_agent: ctx.userAgent ?? null,
      expires_at: expiresAt,
    }),
  )
  const signed = await token.sign({ sub: userId, jti }, config.jwtSecret, {
    expiresIn: SESSION_TTL_SECONDS,
  })
  return { token: signed, jti, expiresAt }
}

export const revokeSession = async (jti: string): Promise<void> => {
  await db().execute(
    from(sessions)
      .where((q) => q("id").equals(jti))
      .update({ revoked_at: new Date() }),
  )
}

/**
 * Enabling 2FA, changing the password, or changing the sign-in email drops
 * every other session. Each of those is either a response to a compromise or
 * creates one if a stale session survives it.
 */
export const revokeAllSessions = async (userId: string, except?: string): Promise<void> => {
  await db().execute(
    from(sessions)
      .where((q) => {
        const preds = [q("user_id").equals(userId), q("revoked_at").isNull()]
        return except ? [...preds, q("id").notEquals(except)] : preds
      })
      .update({ revoked_at: new Date() }),
  )
}

export const readCookie = (header: string | null, name: string): string | null => {
  if (!header) return null
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=")
    if (k === name) return decodeURIComponent(rest.join("="))
  }
  return null
}

export const sessionCookie = (value: string, maxAge = SESSION_TTL_SECONDS): string => {
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : ""
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export const clearedCookie = (): string => sessionCookie("", 0)

export const resolveSession = async (cookieHeader: string | null): Promise<Principal | null> => {
  const raw = readCookie(cookieHeader, SESSION_COOKIE)
  if (!raw) return null

  // token.verify throws on a bad signature or an expired token; both mean "not
  // signed in", which is not an error worth propagating.
  let payload: Record<string, unknown>
  try {
    payload = (await token.verify(raw, config.jwtSecret)) as Record<string, unknown>
  } catch {
    return null
  }
  if (typeof payload.sub !== "string" || typeof payload.jti !== "string") return null
  const claims = { sub: payload.sub, jti: payload.jti }

  // The JWT alone is not enough: a revoked session has to stop working before
  // its expiry, which means a lookup on every request.
  const row = await db().one<{ id: string; user_id: string; revoked_at: Date | null }>(
    from(sessions)
      .select("id", "user_id", "revoked_at")
      .where((q) => [
        q("id").equals(claims.jti),
        q("revoked_at").isNull(),
        q("expires_at").greaterThan(new Date()),
      ]),
  )
  if (!row) return null

  const user = await db().one<Pick<User, "id" | "is_owner" | "status">>(
    from(users)
      .select("id", "is_owner", "status")
      .where((q) => q("id").equals(row.user_id)),
  )
  if (!user || user.status === "terminated") return null

  void db()
    .execute(
      from(sessions)
        .where((q) => q("id").equals(row.id))
        .update({ last_used_at: new Date() }),
    )
    .catch(() => {})

  return { userId: row.user_id, jti: row.id, isOwner: user.is_owner }
}

export const requirePrincipal = async (cookieHeader: string | null): Promise<Principal> => {
  const principal = await resolveSession(cookieHeader)
  if (!principal) throw unauthorized()
  return principal
}

export const requireOwner = (principal: Principal): Principal => {
  if (!principal.isOwner) throw forbidden("Only the instance owner can do that.")
  return principal
}

// --------------------------------------------------------------- mail auth --

export type MailIdentity = {
  address: Address
  domain: Domain
  email: string
}

/**
 * Authenticates a mail client. The username is the full address — mail clients
 * have no notion of a control-panel account, and a bare local part would be
 * ambiguous across hosted domains.
 *
 * Alias and group addresses have no password and can never authenticate; they
 * are routing entries, not accounts.
 */
export const authenticateAddress = async (
  username: string,
  password: string,
): Promise<MailIdentity | null> => {
  const at = username.lastIndexOf("@")
  if (at <= 0) return null
  const localPart = username.slice(0, at).toLowerCase()
  const domainName = username.slice(at + 1).toLowerCase()

  const domain = await db().one<Domain>(from(domains).where((q) => q("name").equals(domainName)))
  if (!domain) return null

  const address = await db().one<Address>(
    from(addresses).where((q) => [
      q("domain_id").equals(domain.id),
      q("local_part").equals(localPart),
    ]),
  )
  if (!address || address.disabled || !address.password_hash) return null
  if (address.type !== "standard" && address.type !== "catchall") return null

  if (!(await verify(password, address.password_hash))) return null

  void db()
    .execute(
      from(addresses)
        .where((q) => q("id").equals(address.id))
        .update({ last_login_at: new Date() }),
    )
    .catch(() => {})

  return { address, domain, email: `${localPart}@${domainName}` }
}

// ------------------------------------------------------- webmail sessions --

export const MAIL_COOKIE = "corsair_webmail"
export const MAIL_SESSION_TTL_SECONDS = 60 * 60 * 12

/**
 * A webmail session, which is a *mailbox* identity rather than an account one.
 *
 * Deliberately a different cookie and a different claim from the panel session.
 * Somebody who has a mailbox password must not thereby be able to reach the
 * control panel and edit the domains it belongs to — the two identities are
 * separate everywhere else in this codebase and conflating them here would
 * quietly undo that.
 *
 * The shorter lifetime is because a webmail session is far more likely to be
 * left open on a machine somebody else can reach.
 */
export const issueMailSession = async (addressId: string): Promise<string> =>
  token.sign({ sub: addressId, kind: "mailbox" }, config.jwtSecret, {
    expiresIn: MAIL_SESSION_TTL_SECONDS,
  })

export const mailCookie = (value: string, maxAge = MAIL_SESSION_TTL_SECONDS): string => {
  const secure = config.publicUrl.startsWith("https://") ? "; Secure" : ""
  return `${MAIL_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

export const clearedMailCookie = (): string => mailCookie("", 0)

export const resolveMailSession = async (
  cookieHeader: string | null,
): Promise<MailIdentity | null> => {
  const raw = readCookie(cookieHeader, MAIL_COOKIE)
  if (!raw) return null

  let payload: Record<string, unknown>
  try {
    payload = (await token.verify(raw, config.jwtSecret)) as Record<string, unknown>
  } catch {
    return null
  }
  // The `kind` claim is what stops a panel session cookie being replayed here
  // and vice versa; both are signed with the same secret.
  if (payload.kind !== "mailbox" || typeof payload.sub !== "string") return null

  const address = await db().one<Address>(
    from(addresses).where((q) => q("id").equals(payload.sub as string)),
  )
  if (!address || address.disabled || !address.password_hash) return null

  const domain = await db().one<Domain>(
    from(domains).where((q) => q("id").equals(address.domain_id)),
  )
  if (!domain) return null

  return { address, domain, email: `${address.local_part}@${domain.name}` }
}

export const requireMailIdentity = async (cookieHeader: string | null): Promise<MailIdentity> => {
  const identity = await resolveMailSession(cookieHeader)
  if (!identity) throw unauthorized("Sign in to your mailbox first.")
  return identity
}

// ------------------------------------------------------------------- bans --

const FAILURE_WINDOW_MS = 15 * 60 * 1000
const FAILURE_THRESHOLD = 10
const BAN_MS = 60 * 60 * 1000

export const isBanned = async (ip: string): Promise<boolean> => {
  const row = await db().one<{ ip: string }>(
    from(bans)
      .select("ip")
      .where((q) => [q("ip").equals(ip), q("expires_at").greaterThan(new Date())]),
  )
  return Boolean(row)
}

/**
 * Records a failed mail login and bans the source once it crosses the
 * threshold. The listeners are on the public internet and are scanned
 * constantly; without this, every one of those attempts costs an Argon2 hash.
 */
export const recordAuthFailure = async (
  ip: string,
  protocol: string,
  username?: string | null,
): Promise<void> => {
  await db().execute(from(authFailures).insert({ ip, protocol, username: username ?? null }))
  const since = new Date(Date.now() - FAILURE_WINDOW_MS)
  const row = await db().one<{ count: string }>({
    text: "SELECT count(*)::text AS count FROM auth_failures WHERE ip = $1 AND created_at > $2",
    values: [ip, since],
  })
  if (Number(row?.count ?? 0) < FAILURE_THRESHOLD) return

  await db().execute({
    text: `INSERT INTO bans (ip, reason, expires_at) VALUES ($1, $2, $3)
           ON CONFLICT (ip) DO UPDATE SET expires_at = EXCLUDED.expires_at, reason = EXCLUDED.reason`,
    values: [ip, `${FAILURE_THRESHOLD} failed ${protocol} logins`, new Date(Date.now() + BAN_MS)],
  })
}

export const clearAuthFailures = async (ip: string): Promise<void> => {
  await db().execute(
    from(authFailures)
      .where((q) => q("ip").equals(ip))
      .del(),
  )
}

// ---------------------------------------------------------------- helpers --

export const hashPassword = (plain: string): Promise<string> => hash(plain)
export const verifyPassword = (plain: string, hashed: string): Promise<boolean> =>
  verify(plain, hashed)

/**
 * Constant-time compare for values an attacker supplies and can retry — TOTP
 * codes, recovery tokens. A length mismatch short-circuits, which leaks only
 * the length, and the length is not the secret.
 */
export const safeEqual = (a: string, b: string): boolean => {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
