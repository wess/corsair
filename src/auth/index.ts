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
  mailSessions,
  sessions,
  type User,
  users,
} from "../schema/index.ts"

export const hashToken = (value: string): string => createHash("sha256").update(value).digest("hex")

// panel auth

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
  // Mailboxes that sign in with this account's password share its credential, so
  // changing the password has to end their webmail sessions too. All of them: the
  // exception is a *panel* session, and keeping it says nothing about a mailbox.
  await db().execute({
    text: `UPDATE mail_sessions SET revoked_at = now()
            WHERE revoked_at IS NULL
              AND address_id IN (SELECT id FROM addresses WHERE user_id = $1)`,
    values: [userId],
  })
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
    if (k === name) {
      // A cookie that is not valid percent-encoding is somebody's garbage, not a
      // server fault: it is no session, and must not surface as a 500.
      try {
        return decodeURIComponent(rest.join("="))
      } catch {
        return null
      }
    }
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

// mail auth

export type MailIdentity = {
  address: Address
  domain: Domain
  email: string
  /** The webmail session this identity came from; absent for a password login over a mail protocol. */
  sessionId?: string
}

/**
 * Authenticates a mail client. The username is the full address — mail clients
 * have no notion of a control-panel account, and a bare local part would be
 * ambiguous across hosted domains.
 *
 * Alias and group addresses have no password and can never authenticate; they
 * are routing entries, not accounts.
 */
/**
 * The hash a mailbox authenticates against.
 *
 * One credential, where the mailbox and the panel account are the same person:
 * a linked address carries no hash of its own and every protocol verifies
 * against the account's. Changing the account password changes the mailbox
 * password because there is only one of them.
 *
 * A mailbox with no link keeps its own hash — the other people on a family or
 * team domain hold a mailbox credential and have no panel login at all. Those
 * are still two identities; this only merges the case where one person was
 * holding two.
 *
 * Returning null locks the mailbox rather than falling through to its own
 * stale hash. A terminated account must not keep collecting mail, and an
 * account with no password (one that only ever signed in another way) has
 * nothing to verify against.
 */
const mailboxHash = async (address: Address): Promise<string | null> => {
  if (!address.user_id) return address.password_hash
  const owner = await db().one<User>(from(users).where((q) => q("id").equals(address.user_id!)))
  if (!owner || owner.status === "terminated") return null
  return owner.password_hash
}

/**
 * Resolves a control-panel sign-in address to the mailbox it opens.
 *
 * Someone who signs up as `me@wess.io` and reads `wess@wess.dev` knows one
 * address and one password. Making them remember a second address to type into
 * a mail client — while the password is the same — is the confusion the unified
 * credential was meant to remove, only moved one field to the left.
 *
 * Only ever resolves to a mailbox already linked to that account, so this grants
 * no access the account password did not already have. It is a second name for
 * the same door.
 *
 * Ambiguity is refused rather than guessed. With more than one linked mailbox
 * there is no answer to "which inbox did you mean", and picking one would
 * silently show somebody the wrong mail; they name the mailbox instead.
 */
const mailboxForAccountEmail = async (email: string): Promise<Address | null> => {
  const user = await db().one<User>(from(users).where((q) => q("email").equals(email)))
  if (!user || user.status === "terminated" || !user.password_hash) return null

  const linked = await db().all<Address>(
    from(addresses).where((q) => [q("user_id").equals(user.id), q("disabled").equals(false)]),
  )
  return linked.length === 1 ? (linked[0] as Address) : null
}

/**
 * An agent mailbox's password is its API token.
 *
 * The same `ca_` secret opens the HTTP API and, here, IMAP, POP3, SMTP
 * submission and the webmail, so an agent holds one credential and a harness
 * that wants a mail client's settings can be given the address and the token.
 * What it can *do* once in is narrower than a person's mailbox — see
 * `reserveSends` and `mayUseSender` for sending — but reading is the same.
 *
 * Compared as SHA-256 digests in constant time, the way the token is stored. It
 * is a 256-bit random value, so there is nothing to slow down with a password
 * hash; the protocol listeners' failure bans still apply.
 */
const authenticateAgent = async (
  address: Address,
  password: string,
): Promise<MailIdentity | null> => {
  // Not a token, so not worth a query. Also keeps a person's ordinary password
  // guess from touching the agents table at all.
  if (!password.startsWith("ca_")) return null

  const row = await db().one<{ id: string; token_hash: string }>({
    text: `SELECT g.id, g.token_hash FROM agents g
             JOIN users u ON u.id = g.user_id
            WHERE g.address_id = $1 AND u.status <> 'terminated'`,
    values: [address.id],
  })
  if (!row) return null

  const given = Buffer.from(hashToken(password), "hex")
  const expected = Buffer.from(row.token_hash, "hex")
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null

  const domain = await db().one<Domain>(
    from(domains).where((q) => q("id").equals(address.domain_id)),
  )
  if (!domain) return null

  void db()
    .execute({
      text: "UPDATE agents SET last_used_at = now() WHERE id = $1",
      values: [row.id],
    })
    .catch(() => {})

  return { address, domain, email: `${address.local_part}@${domain.name}` }
}

/**
 * Verifies a password against a resolved mailbox and builds its identity.
 *
 * Shared by both ways in — the mailbox address itself, and the owner's
 * control-panel sign-in address — so the two cannot disagree about what counts
 * as a valid mailbox or which hash to check.
 */
const authenticateResolved = async (
  address: Address,
  password: string,
): Promise<MailIdentity | null> => {
  if (address.disabled) return null
  if (address.type === "agent") return authenticateAgent(address, password)
  if (address.type !== "standard" && address.type !== "catchall") return null

  /**
   * One credential, where the mailbox and the panel account are the same
   * person: the address carries no hash of its own and this verifies against
   * the account's. Changing the account password changes the mailbox password
   * because there is only one of them.
   *
   * A mailbox with no linked account still has its own hash — the other people
   * on a family or team domain hold a mailbox credential and no panel login.
   *
   * A terminated or password-less account cannot authenticate anywhere. The
   * check is here rather than at the call sites so that SMTP, IMAP, POP3, and
   * the webmail cannot disagree about it.
   */
  const expected = await mailboxHash(address)
  if (!expected) return null
  if (!(await verifyPassword(password, expected))) return null

  const domain = await db().one<Domain>(
    from(domains).where((q) => q("id").equals(address.domain_id)),
  )
  if (!domain) return null

  void db()
    .execute(
      from(addresses)
        .where((q) => q("id").equals(address.id))
        .update({ last_login_at: new Date() }),
    )
    .catch(() => {})

  return { address, domain, email: `${address.local_part}@${domain.name}` }
}

/**
 * Checks a password against a mailbox without signing anything in.
 *
 * Shares `mailboxHash` with `authenticateResolved`, so confirming the current
 * password before changing it cannot disagree with what the login path would
 * have accepted — the linked-account case in particular, where the credential
 * being checked is the owner's and not the address's.
 *
 * Deliberately does not touch `last_login_at`. Proving you already hold the
 * credential is not a sign-in, and recording it as one would put a login on the
 * mailbox every time somebody opened the settings panel and changed their mind.
 */
export const verifyMailboxPassword = async (
  address: Address,
  password: string,
): Promise<boolean> => {
  const expected = await mailboxHash(address)
  return expected ? verifyPassword(password, expected) : false
}

export const authenticateAddress = async (
  username: string,
  password: string,
): Promise<MailIdentity | null> => {
  const at = username.lastIndexOf("@")
  if (at <= 0) return null
  const localPart = username.slice(0, at).toLowerCase()
  const domainName = username.slice(at + 1).toLowerCase()

  const domain = await db().one<Domain>(from(domains).where((q) => q("name").equals(domainName)))
  if (!domain) {
    // Not a hosted domain — but it may still be somebody's panel sign-in
    // address, which opens the one mailbox linked to that account.
    const viaAccount = await mailboxForAccountEmail(username.toLowerCase())
    return viaAccount ? authenticateResolved(viaAccount, password) : null
  }

  const address = await db().one<Address>(
    from(addresses).where((q) => [
      q("domain_id").equals(domain.id),
      q("local_part").equals(localPart),
    ]),
  )
  if (!address) return null
  return authenticateResolved(address, password)
}

// webmail sessions

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
export const issueMailSession = async (
  addressId: string,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
): Promise<string> => {
  // The id is the session. It is random and unguessable, and the token is only
  // good while a row with this id is live — see the migration for why.
  const jti = randomUUID()
  await db().execute(
    from(mailSessions).insert({
      id: jti,
      address_id: addressId,
      ip: ctx.ip ?? null,
      user_agent: ctx.userAgent ?? null,
      expires_at: new Date(Date.now() + MAIL_SESSION_TTL_SECONDS * 1000),
    }),
  )
  return token.sign({ sub: addressId, kind: "mailbox", jti }, config.jwtSecret, {
    expiresIn: MAIL_SESSION_TTL_SECONDS,
  })
}

/**
 * Ends the session a cookie names, so a copied cookie dies with the logout
 * instead of living until it expires. A cookie that does not verify has nothing
 * to end.
 */
export const endMailSession = async (cookieHeader: string | null): Promise<void> => {
  const raw = readCookie(cookieHeader, MAIL_COOKIE)
  if (!raw) return
  try {
    const payload = (await token.verify(raw, config.jwtSecret)) as Record<string, unknown>
    if (payload.kind !== "mailbox" || typeof payload.jti !== "string") return
    await db().execute(
      from(mailSessions)
        .where((q) => [q("id").equals(payload.jti as string), q("revoked_at").isNull()])
        .update({ revoked_at: new Date() }),
    )
  } catch {
    // Not a valid token: nothing to revoke.
  }
}

/**
 * Ends every webmail session of one address, except the one named. Called when
 * its credential changes, is linked or unlinked, or the address is disabled — a
 * session that survives its own password being changed is the stolen cookie the
 * change was made to get rid of.
 */
export const revokeMailSessions = async (addressId: string, except?: string): Promise<void> => {
  await db().execute(
    from(mailSessions)
      .where((q) => {
        const live = [q("address_id").equals(addressId), q("revoked_at").isNull()]
        return except ? [...live, q("id").notEquals(except)] : live
      })
      .update({ revoked_at: new Date() }),
  )
}

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
  // A token with no session id predates server-side sessions and is not honoured.
  if (typeof payload.jti !== "string") return null

  const session = await db().one<{ id: string }>(
    from(mailSessions)
      .select("id")
      .where((q) => [
        q("id").equals(payload.jti as string),
        q("address_id").equals(payload.sub as string),
        q("revoked_at").isNull(),
        q("expires_at").greaterThan(new Date()),
      ]),
  )
  if (!session) return null

  const address = await db().one<Address>(
    from(addresses).where((q) => q("id").equals(payload.sub as string)),
  )
  // NOT `address.password_hash`: a mailbox linked to a control-panel account
  // deliberately has none, and checking for one here invalidated the session on
  // the very next request — sign-in succeeded, then everything answered "Sign in
  // to your mailbox first". `mailboxHash` asks the real question, and still
  // ends the session if the owning account is terminated.
  if (!address || address.disabled) return null
  if (!(await mailboxHash(address))) return null

  const domain = await db().one<Domain>(
    from(domains).where((q) => q("id").equals(address.domain_id)),
  )
  if (!domain) return null

  // At most once a minute: a busy client should not turn every request into a
  // write to this row.
  void db()
    .execute({
      text: `UPDATE mail_sessions SET last_used_at = now()
              WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      values: [session.id],
    })
    .catch(() => {})

  return { address, domain, email: `${address.local_part}@${domain.name}`, sessionId: session.id }
}

export const requireMailIdentity = async (cookieHeader: string | null): Promise<MailIdentity> => {
  const identity = await resolveMailSession(cookieHeader)
  if (!identity) throw unauthorized("Sign in to your mailbox first.")
  return identity
}

// bans

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

// helpers

export const hashPassword = (plain: string): Promise<string> => hash(plain)

/**
 * Argon2id holds tens of megabytes while it runs, and every login path funnels
 * through it. On a 1 GB box a few dozen concurrent guesses is the whole of RAM,
 * so verifies queue behind a small gate instead of all running at once. The
 * failure bans and rate limits decide *who* may try; this decides how many
 * tries are in flight.
 */
const MAX_VERIFIES = 4
let verifying = 0
const waiting: (() => void)[] = []

const gated = async <T>(work: () => Promise<T>): Promise<T> => {
  if (verifying >= MAX_VERIFIES) await new Promise<void>((resolve) => waiting.push(resolve))
  verifying++
  try {
    return await work()
  } finally {
    verifying--
    waiting.shift()?.()
  }
}

export const verifyPassword = (plain: string, hashed: string): Promise<boolean> =>
  gated(() => verify(plain, hashed))

// A hash to verify against when the account does not exist, so an unknown
// address costs the same time as a wrong password rather than answering early.
let decoy: Promise<string> | null = null
export const spendVerifyTime = async (plain: string): Promise<void> => {
  decoy ??= hash("corsair-decoy-password")
  await verifyPassword(plain, await decoy)
}

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
