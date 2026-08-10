import { createHash } from "node:crypto"
import { from } from "@atlas/db"
import { generateBackupCodes, generateSecret, otpauthUrl, verifyTotp } from "@atlas/security"
import { getR, json, postR, type Route } from "@atlas/server"
import { z } from "zod"
import {
  clearedCookie,
  hashPassword,
  issueSession,
  revokeAllSessions,
  revokeSession,
  safeEqual,
  sessionCookie,
  verifyPassword,
} from "../../../auth/index.ts"
import { config } from "../../../config/index.ts"
import { db } from "../../../db/index.ts"
import { conflict, forbidden, invalidParameter, unauthorized } from "../../../errors/index.ts"
import { referralCode } from "../../../ids/index.ts"
import { consumeToken, sendPasswordReset, sendVerification } from "../../../notify/index.ts"
import { plans, referrals, subscriptions, type User, users } from "../../../schema/index.ts"
import { userObject } from "../../../serialize/index.ts"
import { authed, ipOf, principalOf, publicLimit } from "../../pipes/index.ts"

const email = z.string().email().max(320)
const password = z.string().min(12).max(200)

const userById = async (id: string): Promise<User> => {
  const row = await db().one<User>(from(users).where((q) => q("id").equals(id)))
  if (!row) throw unauthorized()
  return row
}

/**
 * Starts a trial subscription for a new account. Without one, `entitlementOf`
 * falls back to the trial plan anyway — this exists so the Billing screen has
 * a period end to show and so an upgrade has a row to mutate.
 */
const startTrial = async (userId: string): Promise<void> => {
  const trial = await db().one<{ id: string }>(
    from(plans)
      .select("id")
      .where((q) => q("is_trial").equals(true))
      .orderBy("position", "ASC"),
  )
  if (!trial) return
  await db()
    .execute(
      from(subscriptions).insert({
        user_id: userId,
        plan_id: trial.id,
        status: "trialing",
        interval: "yearly",
        current_period_end: new Date(Date.now() + 30 * 86_400_000),
      }),
    )
    .catch(() => {})
}

export const authRoutes: Route[] = [
  postR(
    "/api/auth/signup",
    {
      body: z.object({
        email,
        password,
        name: z.string().max(120).optional(),
        referred_by: z.string().max(32).optional(),
      }),
      before: [publicLimit],
      assigns: {} as never,
    },
    async (c) => {
      if (config.signups !== "open") {
        const existing = await db().one<{ id: string }>({
          text: "SELECT id FROM users LIMIT 1",
          values: [],
        })
        if (existing) throw forbidden("Signups are closed on this server.")
      }

      const referrer = c.body.referred_by
        ? await db().one<{ id: string }>(
            from(users)
              .select("id")
              .where((q) => q("referral_code").equals(c.body.referred_by!)),
          )
        : null

      const hashed = await hashPassword(c.body.password)

      /**
       * The first account owns the instance. The claim is made inside the
       * INSERT and guarded by the partial unique index, so two concurrent
       * signups cannot both win — the loser retries as a non-owner rather than
       * failing, which is why this catch is scoped to that one constraint.
       * Widening it would swallow the duplicate-email violation.
       */
      const insert = (asOwner: boolean) =>
        db().one<User>({
          text: `INSERT INTO users (email, password_hash, name, referral_code, referred_by, is_owner)
                 VALUES ($1, $2, $3, $4, $5, ${asOwner ? "NOT EXISTS (SELECT 1 FROM users)" : "false"})
                 RETURNING *`,
          values: [
            c.body.email.toLowerCase(),
            hashed,
            c.body.name ?? null,
            referralCode(),
            referrer?.id ?? null,
          ],
        })

      let user: User | null
      try {
        user = await insert(true)
      } catch (e) {
        const err = e as { errno?: string; code?: string; constraint?: string }
        const sqlstate = err.errno ?? err.code
        if (sqlstate === "23505" && err.constraint === "users_single_owner_idx") {
          user = await insert(false)
        } else if (sqlstate === "23505") {
          throw conflict("An account with that email address already exists.")
        } else throw e
      }
      if (!user) throw conflict("Could not create that account.")

      await startTrial(user.id)

      if (referrer) {
        await db()
          .execute(from(referrals).insert({ referrer_id: referrer.id, referred_id: user.id }))
          .catch(() => {})
      }

      const session = await issueSession(user.id, {
        ip: ipOf(c as never),
        userAgent: c.headers.get("user-agent"),
      })

      const response = json(c, 201, userObject(user))
      return {
        ...response,
        respHeaders: new Headers([
          ...response.respHeaders,
          ["set-cookie", sessionCookie(session.token)],
        ]),
      }
    },
  ),

  postR(
    "/api/auth/login",
    {
      body: z.object({ email, password: z.string().max(200), code: z.string().max(12).optional() }),
      before: [publicLimit],
      assigns: {} as never,
    },
    async (c) => {
      const user = await db().one<User>(
        from(users).where((q) => q("email").equals(c.body.email.toLowerCase())),
      )

      // The same reply whether the address is unknown or the password is wrong,
      // so the endpoint cannot be used to enumerate accounts.
      const failed = unauthorized("Those credentials are not valid.")
      if (!user?.password_hash) throw failed
      if (!(await verifyPassword(c.body.password, user.password_hash))) throw failed
      if (user.status === "terminated") throw forbidden("This account has been terminated.")

      if (user.totp_enabled) {
        if (!c.body.code) {
          return json(c, 200, { object: "challenge", totp_required: true })
        }
        const ok =
          user.totp_secret &&
          verifyTotp(c.body.code.replace(/\s/g, ""), user.totp_secret, { window: 1 })
        const backup =
          !ok &&
          (user.backup_codes ?? []).some((stored) =>
            safeEqual(stored, createHash("sha256").update(c.body.code!.trim()).digest("hex")),
          )
        if (!ok && !backup) throw unauthorized("That two-factor code is not valid.")

        if (backup) {
          const used = createHash("sha256").update(c.body.code!.trim()).digest("hex")
          await db().execute(
            from(users)
              .where((q) => q("id").equals(user.id))
              .update({ backup_codes: (user.backup_codes ?? []).filter((c2) => c2 !== used) }),
          )
        }
      }

      const session = await issueSession(user.id, {
        ip: ipOf(c as never),
        userAgent: c.headers.get("user-agent"),
      })
      const response = json(c, 200, userObject(user))
      return {
        ...response,
        respHeaders: new Headers([
          ...response.respHeaders,
          ["set-cookie", sessionCookie(session.token)],
        ]),
      }
    },
  ),

  postR("/api/auth/logout", { before: [], assigns: {} as never }, async (c) => {
    const { resolveSession } = await import("../../../auth/index.ts")
    const principal = await resolveSession(c.headers.get("cookie"))
    if (principal) await revokeSession(principal.jti)
    const response = json(c, 200, { object: "logout", ok: true })
    return {
      ...response,
      respHeaders: new Headers([...response.respHeaders, ["set-cookie", clearedCookie()]]),
    }
  }),

  getR("/api/auth/me", { before: authed, assigns: {} as never }, async (c) =>
    json(c, 200, userObject(await userById(principalOf(c).userId))),
  ),

  // ------------------------------------------------------------------ 2FA --

  postR("/api/auth/totp/setup", { before: authed, assigns: {} as never }, async (c) => {
    const user = await userById(principalOf(c).userId)
    if (user.totp_enabled) throw conflict("Two-factor authentication is already enabled.")

    // Stored before it is confirmed so the code the user is about to type can
    // be checked against it; `totp_enabled` is what actually gates login.
    const secret = generateSecret()
    await db().execute(
      from(users)
        .where((q) => q("id").equals(user.id))
        .update({ totp_secret: secret, updated_at: new Date() }),
    )

    return json(c, 200, {
      object: "totp_setup",
      secret,
      otpauth_url: otpauthUrl({
        secret,
        account: user.email,
        issuer: new URL(config.publicUrl).hostname,
      }),
    })
  }),

  postR(
    "/api/auth/totp/enable",
    { body: z.object({ code: z.string().min(6).max(10) }), before: authed, assigns: {} as never },
    async (c) => {
      const user = await userById(principalOf(c).userId)
      if (!user.totp_secret) throw invalidParameter("Start the setup first.")
      if (!verifyTotp(c.body.code.replace(/\s/g, ""), user.totp_secret, { window: 1 })) {
        throw invalidParameter("That code is not valid. Check your device's clock.")
      }

      const codes = generateBackupCodes(10)
      await db().execute(
        from(users)
          .where((q) => q("id").equals(user.id))
          .update({
            totp_enabled: true,
            // Only hashes are stored: a backup code is a password.
            backup_codes: codes.map((code) => createHash("sha256").update(code).digest("hex")),
            updated_at: new Date(),
          }),
      )

      // Enabling 2FA invalidates every other session, which is the point —
      // turning it on is usually a response to a suspected compromise.
      await revokeAllSessions(user.id, principalOf(c).jti)

      return json(c, 200, { object: "totp", enabled: true, backup_codes: codes })
    },
  ),

  // ------------------------------------------------------- verification --

  postR("/api/auth/verify/send", { before: authed, assigns: {} as never }, async (c) => {
    const user = await userById(principalOf(c).userId)
    if (user.email_verified_at) {
      return json(c, 200, { object: "verification", verified: true })
    }
    await sendVerification(user)
    return json(c, 202, { object: "verification", sent: true })
  }),

  postR(
    "/api/auth/verify",
    {
      body: z.object({ token: z.string().min(10).max(200) }),
      before: [publicLimit],
      assigns: {} as never,
    },
    async (c) => {
      const row = await consumeToken("email_verify", c.body.token)
      if (!row?.user_id) throw invalidParameter("That link is invalid or has expired.")
      await db().execute(
        from(users)
          .where((q) => q("id").equals(row.user_id!))
          .update({ email_verified_at: new Date(), updated_at: new Date() }),
      )
      return json(c, 200, { object: "verification", verified: true })
    },
  ),

  // ------------------------------------------------------ password reset --

  postR(
    "/api/auth/password/forgot",
    { body: z.object({ email }), before: [publicLimit], assigns: {} as never },
    async (c) => {
      const user = await db().one<User>(
        from(users).where((q) => q("email").equals(c.body.email.toLowerCase())),
      )
      // Always the same answer. Telling an anonymous caller whether an address
      // has an account here turns this endpoint into an account enumerator.
      if (user && user.status !== "terminated") {
        await sendPasswordReset(user).catch((e) =>
          console.error("[corsair] could not send a password reset:", e),
        )
      }
      return json(c, 202, {
        object: "password_reset",
        sent: true,
        message: "If that address has an account, a reset link is on its way.",
      })
    },
  ),

  postR(
    "/api/auth/password/reset",
    {
      body: z.object({ token: z.string().min(10).max(200), password }),
      before: [publicLimit],
      assigns: {} as never,
    },
    async (c) => {
      const row = await consumeToken("password_reset", c.body.token)
      if (!row?.user_id) throw invalidParameter("That link is invalid or has expired.")

      await db().execute(
        from(users)
          .where((q) => q("id").equals(row.user_id!))
          .update({
            password_hash: await hashPassword(c.body.password),
            updated_at: new Date(),
          }),
      )
      // Whoever asked for this may be locked out by somebody else's session.
      await revokeAllSessions(row.user_id)
      return json(c, 200, { object: "password_reset", reset: true })
    },
  ),

  postR(
    "/api/auth/totp/disable",
    { body: z.object({ password: z.string().max(200) }), before: authed, assigns: {} as never },
    async (c) => {
      const user = await userById(principalOf(c).userId)
      if (!user.password_hash || !(await verifyPassword(c.body.password, user.password_hash))) {
        throw unauthorized("That password is not correct.")
      }
      await db().execute(
        from(users)
          .where((q) => q("id").equals(user.id))
          .update({
            totp_enabled: false,
            totp_secret: null,
            backup_codes: null,
            updated_at: new Date(),
          }),
      )
      return json(c, 200, { object: "totp", enabled: false })
    },
  ),
]
