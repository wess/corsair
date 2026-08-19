import { from } from "@atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { administeredDomain, grantFor } from "../../../access/index.ts"
import {
  createAddress,
  destinationsOf,
  linkToAccount,
  setPassword,
  unlinkFromAccount,
} from "../../../addresses/index.ts"
import { allColumns, db, num } from "../../../db/index.ts"
import { conflict, invalidParameter, notFound } from "../../../errors/index.ts"
import { emit } from "../../../events/index.ts"
import { paginate, parsePageQuery } from "../../../pagination/index.ts"
import {
  type Address,
  addressDestinations,
  addresses,
  type Domain,
  type Filter,
  filters,
} from "../../../schema/index.ts"
import { addressObject } from "../../../serialize/index.ts"
import { authed, authedWithPlan, entitlementFrom, principalOf } from "../../pipes/index.ts"

const domainParam = z.object({ domain_id: z.string().uuid() })
const addressParam = z.object({ address_id: z.string().uuid() })

/**
 * Mailboxes are the delegated surface.
 *
 * Everything in this file is reachable by anyone who administers the domain —
 * its owner, a domain administrator named on it, or a system administrator —
 * because "add a mailbox without going through me" is the entire reason the
 * grant exists. What is *not* here is what stays with the owner: the domain
 * itself, its DNS, its billing, and who administers it.
 */
const ownedAddress = async (
  userId: string,
  id: string,
): Promise<{ address: Address; domain: Domain }> => {
  const row = await db().one<Address>(from(addresses).where((q) => q("id").equals(id)))
  if (!row) throw notFound("Address not found.")
  // Resolved through the same check the domain routes use, so an address cannot
  // be reached by a grant its domain would have refused.
  const domain = await administeredDomain(userId, row.domain_id).catch(() => null)
  if (!domain) throw notFound("Address not found.")
  return { address: row, domain }
}

const filterNameOf = async (filterId: string | null): Promise<string | null> => {
  if (!filterId) return null
  const row = await db().one<Filter>(
    from(filters)
      .select("name")
      .where((q) => q("id").equals(filterId)) as never,
  )
  return (row as { name?: string } | null)?.name ?? null
}

export const addressRoutes: Route[] = [
  getR(
    "/api/domains/:domain_id/addresses",
    { params: domainParam, before: authed, assigns: {} as never },
    async (c) => {
      const domain = await administeredDomain(principalOf(c).userId, c.params.domain_id)
      const page = await paginate<Address>({
        source: "addresses",
        columns: "*",
        where: "domain_id = $1",
        values: [domain.id],
        searchColumns: ["local_part", "name"],
        sortable: { mailbox: "local_part", type: "type", data_usage: "bytes_used" },
        defaultSort: "local_part",
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
      })

      const data = await Promise.all(
        page.data.map(async (address) =>
          addressObject(address, {
            domain,
            destinations: (await destinationsOf(address.id)).map((d) => d.destination),
          }),
        ),
      )
      return json(c, 200, { ...page, data })
    },
  ),

  postR(
    "/api/domains/:domain_id/addresses",
    {
      params: domainParam,
      body: z.object({
        local_part: z.string().min(1).max(64),
        type: z.enum(["standard", "alias", "catchall", "group"]),
        name: z.string().max(120).nullable().optional(),
        password: z.string().min(8).max(200).nullable().optional(),
        use_account_password: z.boolean().optional(),
        destinations: z.array(z.string().email().max(320)).max(50).optional(),
        filter_id: z.string().uuid().nullable().optional(),
      }),
      before: authedWithPlan,
      assigns: {} as never,
    },
    async (c) => {
      const domain = await administeredDomain(principalOf(c).userId, c.params.domain_id)
      const grant = await grantFor(principalOf(c).userId, domain)
      const entitlement = entitlementFrom(c)

      /**
       * Only an owner may hand a mailbox their own account password.
       *
       * `createAddress` takes `ownerId` on trust, because until domains could be
       * delegated the route above had already proved the caller owned this
       * domain. A domain administrator is not that: honouring the flag for one
       * would bind a mailbox on somebody else's domain to the *administrator's*
       * credential, which the domain's owner then cannot change — `setPassword`
       * refuses a linked mailbox outright. Refused rather than quietly ignored,
       * because a mailbox that silently got a different password than the one
       * asked for fails later, in a mail client, with nothing to point at.
       */
      if (c.body.use_account_password === true && !grant.owns) {
        throw invalidParameter(
          "Only this domain's owner can give a mailbox their account password. Set a password for this mailbox instead.",
        )
      }

      if (entitlement.plan.max_addresses !== null) {
        const row = await db().one<{ count: string }>({
          text: `SELECT count(*)::text AS count FROM addresses a
                   JOIN domains d ON d.id = a.domain_id WHERE d.user_id = $1`,
          values: [principalOf(c).userId],
        })
        if (Number(row?.count ?? 0) >= entitlement.plan.max_addresses) {
          throw conflict(
            `The ${entitlement.plan.name} plan allows ${entitlement.plan.max_addresses} address(es).`,
          )
        }
      }

      const created = await createAddress({
        domainId: domain.id,
        localPart: c.body.local_part,
        type: c.body.type,
        name: c.body.name ?? null,
        password: c.body.password ?? null,
        // Guarded above: only reachable when this caller owns the domain, which
        // is the condition the whole arrangement rests on.
        useAccountPassword: c.body.use_account_password === true,
        ownerId: principalOf(c).userId,
        destinations: c.body.destinations,
        filterId: c.body.filter_id ?? null,
      })

      void emit({
        userId: principalOf(c).userId,
        domainId: domain.id,
        type: "address.created",
        data: {
          address: `${created.address.local_part}@${domain.name}`,
          type: created.address.type,
          destinations: created.destinations.map((d) => d.destination),
        },
      })

      return json(
        c,
        201,
        addressObject(created.address, {
          domain,
          destinations: created.destinations.map((d) => d.destination),
        }),
      )
    },
  ),

  getR(
    "/api/addresses/:address_id",
    { params: addressParam, before: authed, assigns: {} as never },
    async (c) => {
      const { address, domain } = await ownedAddress(principalOf(c).userId, c.params.address_id)
      return json(
        c,
        200,
        addressObject(address, {
          domain,
          destinations: (await destinationsOf(address.id)).map((d) => d.destination),
          filterName: await filterNameOf(address.filter_id),
        }),
      )
    },
  ),

  getR(
    "/api/addresses/:address_id/activity",
    { params: addressParam, before: authed, assigns: {} as never },
    async (c) => {
      const { address } = await ownedAddress(principalOf(c).userId, c.params.address_id)
      const rows = await db().all<{ day: string; direction: string; count: string }>({
        text: `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                      direction, count(*)::text AS count
                 FROM mail_log
                WHERE address_id = $1 AND created_at > now() - interval '30 days'
                GROUP BY 1, 2
                ORDER BY 1`,
        values: [address.id],
      })

      // Zero-filled so the chart has a point per day rather than gaps that the
      // renderer has to guess at.
      const days: Record<string, { sent: number; received: number }> = {}
      for (let i = 29; i >= 0; i--) {
        const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
        days[key] = { sent: 0, received: 0 }
      }
      for (const row of rows) {
        const bucket = days[row.day]
        if (!bucket) continue
        if (row.direction === "outbound") bucket.sent = Number(row.count)
        else bucket.received = Number(row.count)
      }

      return json(c, 200, {
        object: "activity",
        days: Object.entries(days).map(([day, counts]) => ({ day, ...counts })),
      })
    },
  ),

  patchR(
    "/api/addresses/:address_id",
    {
      params: addressParam,
      body: z.object({
        name: z.string().max(120).nullable().optional(),
        filter_id: z.string().uuid().nullable().optional(),
        destinations: z.array(z.string().email().max(320)).max(50).optional(),
        disabled: z.boolean().optional(),
        daily_out_limit: z.number().int().min(0).max(100_000).nullable().optional(),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const { address, domain } = await ownedAddress(principalOf(c).userId, c.params.address_id)

      if (c.body.filter_id) {
        const filter = await db().one<{ id: string }>(
          from(filters)
            .select("id")
            .where((q) => [
              q("id").equals(c.body.filter_id!),
              q("user_id").equals(principalOf(c).userId),
            ]),
        )
        if (!filter) throw invalidParameter("That filter does not belong to this account.")
      }

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.name !== undefined) patch.name = c.body.name
      if (c.body.filter_id !== undefined) patch.filter_id = c.body.filter_id
      if (c.body.disabled !== undefined) patch.disabled = c.body.disabled
      if (c.body.daily_out_limit !== undefined) patch.daily_out_limit = c.body.daily_out_limit

      const updated = await db().one<Address>(
        from(addresses)
          .where((q) => q("id").equals(address.id))
          .update(patch)
          .returning(...allColumns(addresses)),
      )

      if (c.body.destinations) {
        if (address.type !== "alias" && address.type !== "group") {
          throw invalidParameter("Only aliases and groups have destinations.")
        }
        if (address.type === "alias" && c.body.destinations.length !== 1) {
          throw invalidParameter("An alias forwards to exactly one address.")
        }
        await db().execute(
          from(addressDestinations)
            .where((q) => q("address_id").equals(address.id))
            .del(),
        )
        for (const [index, destination] of c.body.destinations.entries()) {
          await db().execute(
            from(addressDestinations).insert({
              address_id: address.id,
              destination: destination.trim().toLowerCase(),
              position: index,
            }),
          )
        }
      }

      return json(
        c,
        200,
        addressObject(updated!, {
          domain,
          destinations: (await destinationsOf(address.id)).map((d) => d.destination),
          filterName: await filterNameOf(updated!.filter_id),
        }),
      )
    },
  ),

  postR(
    "/api/addresses/:address_id/password",
    {
      params: addressParam,
      body: z.object({ password: z.string().min(8).max(200) }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const { address } = await ownedAddress(principalOf(c).userId, c.params.address_id)
      if (address.type === "alias" || address.type === "group") {
        throw invalidParameter("Forwarding addresses have no password.")
      }
      await setPassword(address.id, c.body.password)
      void emit({
        userId: principalOf(c).userId,
        domainId: address.domain_id,
        type: "address.password_changed",
        data: { address_id: address.id, local_part: address.local_part },
      })
      return json(c, 200, { object: "address", id: address.id, password_changed: true })
    },
  ),

  /**
   * Make this mailbox sign in with the account password, or give it one of its
   * own again.
   *
   * Linking is owner-only, for the reason spelled out on the create route:
   * `linkToAccount` binds the mailbox to whichever account is passed and checks
   * no ownership of its own, so a domain administrator could otherwise point a
   * mailbox on somebody else's domain at their own credential and leave the
   * domain's owner unable to change it. Unlinking stays open to any
   * administrator — it hands the mailbox back its own password, which is the
   * remedy, not the hazard.
   *
   * Unlinking demands a password rather than accepting none: a mailbox nothing
   * can sign into fails later, as a client that has quietly stopped working.
   */
  postR(
    "/api/addresses/:address_id/link",
    {
      params: addressParam,
      body: z.object({
        use_account_password: z.boolean(),
        password: z.string().min(8).max(200).optional(),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const { address, domain } = await ownedAddress(principalOf(c).userId, c.params.address_id)

      if (c.body.use_account_password) {
        if (!(await grantFor(principalOf(c).userId, domain)).owns) {
          throw invalidParameter(
            "Only this domain's owner can give a mailbox their account password. Set a password for this mailbox instead.",
          )
        }
        await linkToAccount(address.id, principalOf(c).userId)
      } else {
        if (!c.body.password) {
          throw invalidParameter("Set a password for this mailbox before separating it.")
        }
        await unlinkFromAccount(address.id, c.body.password)
      }

      void emit({
        userId: principalOf(c).userId,
        domainId: address.domain_id,
        type: "address.password_changed",
        data: { address_id: address.id, local_part: address.local_part },
      })
      return json(c, 200, {
        object: "address",
        id: address.id,
        uses_account_password: c.body.use_account_password,
      })
    },
  ),

  getR(
    "/api/addresses/:address_id/folders",
    { params: addressParam, before: authed, assigns: {} as never },
    async (c) => {
      const { address } = await ownedAddress(principalOf(c).userId, c.params.address_id)
      const rows = await db().all<{
        id: string
        name: string
        special_use: string | null
        total: string
        unseen: string
        bytes: string
      }>({
        text: `SELECT f.id, f.name, f.special_use,
                      count(m.id) FILTER (WHERE m.expunged_at IS NULL)::text AS total,
                      count(m.id) FILTER (WHERE m.expunged_at IS NULL
                        AND NOT (m.flags @> '["\\\\Seen"]'::jsonb))::text AS unseen,
                      coalesce(sum(m.size) FILTER (WHERE m.expunged_at IS NULL), 0)::text AS bytes
                 FROM folders f LEFT JOIN messages m ON m.folder_id = f.id
                WHERE f.address_id = $1
                GROUP BY f.id ORDER BY f.name`,
        values: [address.id],
      })
      return json(c, 200, {
        object: "list",
        data: rows.map((r) => ({
          object: "folder" as const,
          id: r.id,
          name: r.name,
          special_use: r.special_use,
          messages: Number(r.total),
          unseen: Number(r.unseen),
          bytes: Number(r.bytes),
        })),
      })
    },
  ),

  delR(
    "/api/addresses/:address_id",
    { params: addressParam, before: authed, assigns: {} as never },
    async (c) => {
      const { address } = await ownedAddress(principalOf(c).userId, c.params.address_id)
      const bytes = num(address.bytes_used)
      await db().execute(
        from(addresses)
          .where((q) => q("id").equals(address.id))
          .del(),
      )

      // The cascade removed the messages but not the domain's running total.
      if (bytes) {
        await db().execute({
          text: "UPDATE domains SET bytes_used = GREATEST(0, bytes_used - $2) WHERE id = $1",
          values: [address.domain_id, bytes],
        })
      }
      void emit({
        userId: principalOf(c).userId,
        domainId: address.domain_id,
        type: "address.deleted",
        data: { address_id: address.id, local_part: address.local_part },
      })
      return json(c, 200, { object: "address", id: address.id, deleted: true })
    },
  ),
]
