import { from } from "@atlas/db"
import { delR, getR, json, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { isSystemAdmin, ownedDomain } from "../../../access/index.ts"
import { allColumns, db } from "../../../db/index.ts"
import { conflict, invalidParameter, notFound } from "../../../errors/index.ts"
import { emit } from "../../../events/index.ts"
import { domainAdmins, type User, users } from "../../../schema/index.ts"
import { authed, ownerOnly, principalOf } from "../../pipes/index.ts"

/**
 * Delegating administration.
 *
 * Two scopes, and they are granted by different people on purpose. A **system**
 * administrator acts on every domain on the box, so only the instance owner may
 * appoint one. A **domain** administrator acts on one domain's mailboxes, so
 * the person who owns that domain appoints them — that is the whole point, and
 * routing it through the operator every time is the thing being fixed.
 *
 * Neither grant can be used to widen itself: `POST /api/admins` is `ownerOnly`,
 * and the per-domain routes resolve through `ownedDomain`, which a domain
 * administrator does not satisfy.
 */

const domainParam = z.object({ domain_id: z.string().uuid() })

const adminObject = (user: User, extra: { grantedAt?: Date | null } = {}) => ({
  object: "admin" as const,
  user_id: user.id,
  email: user.email,
  name: user.name,
  status: user.status,
  is_owner: user.is_owner,
  is_admin: user.is_admin,
  granted_at: extra.grantedAt?.toISOString() ?? null,
})

const userByEmail = async (email: string): Promise<User> => {
  const user = await db().one<User>(
    from(users).where((q) => q("email").equals(email.trim().toLowerCase())),
  )
  // Named rather than silently ignored: "nothing happened and I cannot tell
  // why" is the worst outcome for a grant, and a panel account is not a secret
  // to the operator granting rights over their own server.
  if (!user) throw notFound("No account on this server has that email address.")
  if (user.status !== "active") {
    throw invalidParameter("That account is suspended or terminated.")
  }
  return user
}

export const adminRoutes: Route[] = [
  // ------------------------------------------------------- system admins --

  getR("/api/admins", { before: ownerOnly, assigns: {} as never }, async (c) => {
    const rows = await db().all<User>(
      from(users)
        .where((q) => q("is_admin").equals(true))
        .orderBy("email", "ASC"),
    )
    const owner = await db().one<User>(from(users).where((q) => q("is_owner").equals(true)))
    return json(c, 200, {
      object: "list",
      // The owner is listed alongside them because "who can act on everything
      // here" is the question being asked, and answering it without the one
      // account that always can would be a lie of omission.
      data: [...(owner ? [adminObject(owner)] : []), ...rows.map((u) => adminObject(u))],
    })
  }),

  postR(
    "/api/admins",
    {
      body: z.object({ email: z.string().email().max(320) }),
      before: ownerOnly,
      assigns: {} as never,
    },
    async (c) => {
      const user = await userByEmail(c.body.email)
      if (user.is_owner) throw conflict("That account already owns this server.")

      await db().execute(
        from(users)
          .where((q) => q("id").equals(user.id))
          .update({ is_admin: true, updated_at: new Date() }),
      )
      void emit({
        userId: principalOf(c).userId,
        type: "admin.granted",
        data: { user_id: user.id, email: user.email, scope: "system" },
      })
      return json(c, 201, adminObject({ ...user, is_admin: true }))
    },
  ),

  delR(
    "/api/admins/:user_id",
    {
      params: z.object({ user_id: z.string().uuid() }),
      before: ownerOnly,
      assigns: {} as never,
    },
    async (c) => {
      const user = await db().one<User>(from(users).where((q) => q("id").equals(c.params.user_id)))
      if (!user) throw notFound("Account not found.")
      // The owner's authority does not come from `is_admin` and cannot be
      // revoked here; without this the screen would offer a button that looks
      // like it demotes the operator and silently does nothing.
      if (user.is_owner) throw invalidParameter("The owner of this server cannot be demoted.")

      await db().execute(
        from(users)
          .where((q) => q("id").equals(user.id))
          .update({ is_admin: false, updated_at: new Date() }),
      )
      void emit({
        userId: principalOf(c).userId,
        type: "admin.revoked",
        data: { user_id: user.id, email: user.email, scope: "system" },
      })
      return json(c, 200, { object: "admin", user_id: user.id, revoked: true })
    },
  ),

  // ------------------------------------------------------- domain admins --

  getR(
    "/api/domains/:domain_id/admins",
    { params: domainParam, before: authed, assigns: {} as never },
    async (c) => {
      const domain = await ownedDomain(principalOf(c).userId, c.params.domain_id)
      const rows = await db().all<User & { granted_at: Date }>({
        text: `SELECT u.*, da.created_at AS granted_at
                 FROM domain_admins da
                 JOIN users u ON u.id = da.user_id
                WHERE da.domain_id = $1
             ORDER BY u.email ASC`,
        values: [domain.id],
      })
      return json(c, 200, {
        object: "list",
        data: rows.map((u) => adminObject(u, { grantedAt: u.granted_at })),
      })
    },
  ),

  postR(
    "/api/domains/:domain_id/admins",
    {
      params: domainParam,
      body: z.object({ email: z.string().email().max(320) }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const domain = await ownedDomain(principalOf(c).userId, c.params.domain_id)
      const user = await userByEmail(c.body.email)

      if (user.id === domain.user_id) {
        throw conflict("That account already owns this domain.")
      }
      if (await isSystemAdmin(user.id)) {
        throw conflict("That account already administers every domain on this server.")
      }

      const existing = await db().one<{ id: string }>(
        from(domainAdmins)
          .select("id")
          .where((q) => [q("domain_id").equals(domain.id), q("user_id").equals(user.id)]),
      )
      // Idempotent: granting twice is the same state, and a 409 here would be a
      // worse answer than the truth.
      if (!existing) {
        await db().execute(
          from(domainAdmins)
            .insert({
              domain_id: domain.id,
              user_id: user.id,
              granted_by: principalOf(c).userId,
            })
            .returning(...allColumns(domainAdmins)),
        )
        void emit({
          userId: principalOf(c).userId,
          domainId: domain.id,
          type: "admin.granted",
          data: { user_id: user.id, email: user.email, scope: "domain" },
        })
      }

      return json(c, 201, adminObject(user, { grantedAt: new Date() }))
    },
  ),

  delR(
    "/api/domains/:domain_id/admins/:user_id",
    {
      params: domainParam.extend({ user_id: z.string().uuid() }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const domain = await ownedDomain(principalOf(c).userId, c.params.domain_id)
      await db().execute(
        from(domainAdmins)
          .where((q) => [q("domain_id").equals(domain.id), q("user_id").equals(c.params.user_id)])
          .del(),
      )
      void emit({
        userId: principalOf(c).userId,
        domainId: domain.id,
        type: "admin.revoked",
        data: { user_id: c.params.user_id, scope: "domain" },
      })
      return json(c, 200, { object: "admin", user_id: c.params.user_id, revoked: true })
    },
  ),
]
