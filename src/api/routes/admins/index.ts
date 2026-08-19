import { from } from "@atlas/db"
import { delR, getR, json, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { isSystemAdmin, ownedDomain } from "../../../access/index.ts"
import { hashPassword } from "../../../auth/index.ts"
import { allColumns, db } from "../../../db/index.ts"
import { conflict, invalidParameter, notFound } from "../../../errors/index.ts"
import { emit } from "../../../events/index.ts"
import { referralCode } from "../../../ids/index.ts"
import { type Address, addresses, domainAdmins, type User, users } from "../../../schema/index.ts"
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
  // ---------------------------------------------------- delegate accounts --

  /**
   * Creates a panel account for somebody the owner wants to delegate to.
   *
   * `SIGNUPS=closed` is the right default for a private server, but it left
   * delegation unusable: a grant needs a `users` row to point at, and the only
   * route that made one refuses once any account exists. So the operator could
   * appoint administrators and had no way to bring one into being.
   *
   * Deliberately **not** the same thing as a mailbox. A mailbox credential must
   * never open the control panel — `issueMailSession` says why — so somebody who
   * reads mail here and administers a domain here holds two credentials. Naming
   * the account after their mailbox is fine and expected; it does not link them.
   *
   * Created verified, because the owner typing an address in their own panel is
   * a stronger claim than a click in a mail client, and an unverified delegate
   * would be locked out of the thing they were just granted.
   */
  postR(
    "/api/users",
    {
      body: z.object({
        email: z.string().email().max(320),
        password: z.string().min(8).max(200),
        name: z.string().max(120).optional(),
      }),
      before: ownerOnly,
      assigns: {} as never,
    },
    async (c) => {
      const email = c.body.email.trim().toLowerCase()
      let user: User | null
      try {
        user = await db().one<User>({
          text: `INSERT INTO users (email, password_hash, name, referral_code, is_owner, email_verified_at)
                 VALUES ($1, $2, $3, $4, false, now())
                 RETURNING *`,
          values: [email, await hashPassword(c.body.password), c.body.name ?? null, referralCode()],
        })
      } catch (e) {
        const err = e as { errno?: string; code?: string }
        if ((err.errno ?? err.code) === "23505") {
          throw conflict("An account with that email address already exists.")
        }
        throw e
      }

      void emit({
        userId: principalOf(c).userId,
        type: "admin.granted",
        data: { user_id: user!.id, email: user!.email, scope: "account_created" },
      })
      return json(c, 201, adminObject(user!))
    },
  ),

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
      const rows = await db().all<{
        subject: string
        user_id: string | null
        address_id: string | null
        email: string
        name: string | null
        granted_at: Date
      }>({
        text: `SELECT 'account' AS subject, u.id AS user_id, NULL::uuid AS address_id,
                      u.email, u.name, da.created_at AS granted_at
                 FROM domain_admins da JOIN users u ON u.id = da.user_id
                WHERE da.domain_id = $1
                UNION ALL
               SELECT 'mailbox', NULL::uuid, a.id,
                      a.local_part || '@' || d.name, a.name, da.created_at
                 FROM domain_admins da
                 JOIN addresses a ON a.id = da.address_id
                 JOIN domains d ON d.id = a.domain_id
                WHERE da.domain_id = $1
             ORDER BY email ASC`,
        values: [domain.id],
      })
      return json(c, 200, {
        object: "list",
        data: rows.map((r) => ({
          object: "admin",
          subject: r.subject,
          user_id: r.user_id,
          address_id: r.address_id,
          email: r.email,
          name: r.name,
          granted_at: r.granted_at.toISOString(),
        })),
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
      const email = c.body.email.trim().toLowerCase()

      /**
       * A mailbox on this domain is preferred over a panel account of the same
       * name, and it is the ordinary case: the person who runs a client's mail
       * is `them@theirdomain`, and giving them a second identity to remember was
       * the thing that made this unusable. A mailbox grant is managed from
       * inside the webmail — see `routes/mailadmin` — so they never see `/app`.
       *
       * A panel account is still granted when the address is not a mailbox here,
       * which covers a colleague who signs in with their own address elsewhere.
       */
      const at = email.lastIndexOf("@")
      const mailbox =
        at > 0 && email.slice(at + 1) === domain.name.toLowerCase()
          ? await db().one<Address>(
              from(addresses).where((q) => [
                q("domain_id").equals(domain.id),
                q("local_part").equals(email.slice(0, at)),
              ]),
            )
          : null

      if (mailbox) {
        if (mailbox.type === "alias" || mailbox.type === "group") {
          throw invalidParameter(
            "A forwarding address cannot administer a domain — it has no mailbox to sign into.",
          )
        }
        const already = await db().one<{ id: string }>(
          from(domainAdmins)
            .select("id")
            .where((q) => [q("domain_id").equals(domain.id), q("address_id").equals(mailbox.id)]),
        )
        if (!already) {
          await db().execute(
            from(domainAdmins)
              .insert({
                domain_id: domain.id,
                address_id: mailbox.id,
                granted_by: principalOf(c).userId,
              })
              .returning(...allColumns(domainAdmins)),
          )
          void emit({
            userId: principalOf(c).userId,
            domainId: domain.id,
            type: "admin.granted",
            data: { address_id: mailbox.id, email, scope: "domain_mailbox" },
          })
        }
        return json(c, 201, {
          object: "admin",
          address_id: mailbox.id,
          email,
          name: mailbox.name,
          subject: "mailbox",
          granted_at: new Date().toISOString(),
        })
      }

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

      return json(c, 201, { ...adminObject(user, { grantedAt: new Date() }), subject: "account" })
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
      // The id names either subject; deleting by both columns covers a grant
      // held by an account and one held by a mailbox without a second route.
      await db().execute({
        text: `DELETE FROM domain_admins
                WHERE domain_id = $1 AND (user_id = $2 OR address_id = $2)`,
        values: [domain.id, c.params.user_id],
      })
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
