import { from } from "@atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { hashPassword, revokeAllSessions, verifyPassword } from "../../../auth/index.ts"
import { config } from "../../../config/index.ts"
import { allColumns, db } from "../../../db/index.ts"
import { conflict, invalidParameter, unauthorized } from "../../../errors/index.ts"
import { referrals, type User, users } from "../../../schema/index.ts"
import { userObject } from "../../../serialize/index.ts"
import { authed, principalOf } from "../../pipes/index.ts"

const userById = async (id: string): Promise<User> => {
  const row = await db().one<User>(from(users).where((q) => q("id").equals(id)))
  if (!row) throw unauthorized()
  return row
}

export const accountRoutes: Route[] = [
  patchR(
    "/api/account",
    {
      body: z.object({
        name: z.string().max(120).nullable().optional(),
        notifications_email: z.string().email().max(320).nullable().optional(),
        theme: z.enum(["light", "dark", "lights_out"]).optional(),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.name !== undefined) patch.name = c.body.name
      if (c.body.notifications_email !== undefined) {
        patch.notifications_email = c.body.notifications_email
      }
      if (c.body.theme !== undefined) patch.theme = c.body.theme

      const row = await db().one<User>(
        from(users)
          .where((q) => q("id").equals(principalOf(c).userId))
          .update(patch)
          .returning(...allColumns(users)),
      )
      return json(c, 200, userObject(row!))
    },
  ),

  postR(
    "/api/account/email",
    {
      body: z.object({ email: z.string().email().max(320), password: z.string().max(200) }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const user = await userById(principalOf(c).userId)
      if (!user.password_hash || !(await verifyPassword(c.body.password, user.password_hash))) {
        throw unauthorized("That password is not correct.")
      }

      const next = c.body.email.toLowerCase()
      if (next === user.email) return json(c, 200, userObject(user))

      const taken = await db().one<{ id: string }>(
        from(users)
          .select("id")
          .where((q) => q("email").equals(next)),
      )
      if (taken) throw conflict("An account with that email address already exists.")

      const row = await db().one<User>(
        from(users)
          .where((q) => q("id").equals(user.id))
          .update({
            email: next,
            // The new address has not been proven yet, so verification restarts.
            email_verified_at: null,
            updated_at: new Date(),
          })
          .returning(...allColumns(users)),
      )

      // The sign-in identity changed; every other session was issued against
      // the old one.
      await revokeAllSessions(user.id, principalOf(c).jti)
      return json(c, 200, userObject(row!))
    },
  ),

  postR(
    "/api/account/password",
    {
      body: z.object({
        current_password: z.string().max(200),
        new_password: z.string().min(12).max(200),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const user = await userById(principalOf(c).userId)
      if (
        !user.password_hash ||
        !(await verifyPassword(c.body.current_password, user.password_hash))
      ) {
        throw unauthorized("That password is not correct.")
      }
      if (c.body.current_password === c.body.new_password) {
        throw invalidParameter("The new password must be different.")
      }

      await db().execute(
        from(users)
          .where((q) => q("id").equals(user.id))
          .update({
            password_hash: await hashPassword(c.body.new_password),
            updated_at: new Date(),
          }),
      )
      await revokeAllSessions(user.id, principalOf(c).jti)
      return json(c, 200, { object: "password", changed: true })
    },
  ),

  patchR(
    "/api/account/notifications",
    {
      body: z.object({
        referrals: z.boolean().optional(),
        quota: z.boolean().optional(),
        security: z.boolean().optional(),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const user = await userById(principalOf(c).userId)
      const merged = { ...(user.notification_prefs ?? {}), ...c.body }
      const row = await db().one<User>(
        from(users)
          .where((q) => q("id").equals(user.id))
          .update({ notification_prefs: merged, updated_at: new Date() })
          .returning(...allColumns(users)),
      )
      return json(c, 200, userObject(row!))
    },
  ),

  getR("/api/account/referrals", { before: authed, assigns: {} as never }, async (c) => {
    const user = await userById(principalOf(c).userId)
    const rows = await db().all<{
      id: string
      created_at: Date
      rewarded_at: Date | null
      reward_months: number
      email: string
    }>({
      text: `SELECT r.id, r.created_at, r.rewarded_at, r.reward_months, u.email
               FROM referrals r JOIN users u ON u.id = r.referred_id
              WHERE r.referrer_id = $1
              ORDER BY r.created_at DESC`,
      values: [user.id],
    })

    return json(c, 200, {
      object: "referral_program",
      code: user.referral_code,
      link: `${config.publicUrl}/signup?referred_by=${user.referral_code}`,
      earned_months: rows.filter((r) => r.rewarded_at).reduce((sum, r) => sum + r.reward_months, 0),
      referrals: rows.map((r) => ({
        id: r.id,
        // Only the local part is shown. The full address of somebody else's
        // account is not the referrer's to see.
        email: `${r.email.split("@")[0]}@…`,
        rewarded: Boolean(r.rewarded_at),
        created_at: r.created_at.toISOString(),
      })),
    })
  }),

  delR("/api/account", { before: authed, assigns: {} as never }, async (c) => {
    const user = await userById(principalOf(c).userId)
    const confirm = c.query?.confirm
    if (confirm !== user.email) {
      throw invalidParameter(
        "Pass ?confirm=<your sign-in email> to confirm terminating the account.",
      )
    }

    // Marked terminated rather than deleted outright: mail in flight has to
    // stop being accepted immediately, but a customer who does this by
    // mistake at 2am should have something left to restore.
    await db().execute(
      from(users)
        .where((q) => q("id").equals(user.id))
        .update({ status: "terminated", terminated_at: new Date(), updated_at: new Date() }),
    )
    await revokeAllSessions(user.id)
    return json(c, 200, { object: "account", terminated: true })
  }),

  getR("/api/account/sessions", { before: authed, assigns: {} as never }, async (c) => {
    const rows = await db().all<{
      id: string
      ip: string | null
      user_agent: string | null
      created_at: Date
      last_used_at: Date | null
    }>({
      text: `SELECT id, ip, user_agent, created_at, last_used_at FROM sessions
              WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
              ORDER BY created_at DESC`,
      values: [principalOf(c).userId],
    })
    return json(c, 200, {
      object: "list",
      data: rows.map((r) => ({
        id: r.id,
        current: r.id === principalOf(c).jti,
        ip: r.ip,
        user_agent: r.user_agent,
        created_at: r.created_at.toISOString(),
        last_used_at: r.last_used_at?.toISOString() ?? null,
      })),
    })
  }),

  postR(
    "/api/account/sessions/revoke-others",
    { before: authed, assigns: {} as never },
    async (c) => {
      await revokeAllSessions(principalOf(c).userId, principalOf(c).jti)
      return json(c, 200, { object: "sessions", revoked: true })
    },
  ),
]

export const referralTable = referrals
