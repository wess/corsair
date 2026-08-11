import { from } from "@atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { createAddress, destinationsOf, setPassword } from "../../../addresses/index.ts"
import { allColumns, db, num } from "../../../db/index.ts"
import { conflict, invalidParameter, notFound } from "../../../errors/index.ts"
import { emit } from "../../../events/index.ts"
import { paginate, parsePageQuery } from "../../../pagination/index.ts"
import {
  type Address,
  addressDestinations,
  addresses,
  type Domain,
  domains,
  type Filter,
  filters,
} from "../../../schema/index.ts"
import { addressObject } from "../../../serialize/index.ts"
import { authed, authedWithPlan, entitlementFrom, principalOf } from "../../pipes/index.ts"

const domainParam = z.object({ domain_id: z.string().uuid() })
const addressParam = z.object({ address_id: z.string().uuid() })

const ownedDomain = async (userId: string, id: string): Promise<Domain> => {
  const row = await db().one<Domain>(
    from(domains).where((q) => [q("id").equals(id), q("user_id").equals(userId)]),
  )
  if (!row) throw notFound("Domain not found.")
  return row
}

const ownedAddress = async (
  userId: string,
  id: string,
): Promise<{ address: Address; domain: Domain }> => {
  const row = await db().one<Address & { d_id: string }>({
    text: `SELECT a.*, d.id AS d_id FROM addresses a
             JOIN domains d ON d.id = a.domain_id
            WHERE a.id = $1 AND d.user_id = $2`,
    values: [id, userId],
  })
  if (!row) throw notFound("Address not found.")
  const domain = (await db().one<Domain>(from(domains).where((q) => q("id").equals(row.d_id))))!
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
      const domain = await ownedDomain(principalOf(c).userId, c.params.domain_id)
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
        destinations: z.array(z.string().email().max(320)).max(50).optional(),
        filter_id: z.string().uuid().nullable().optional(),
      }),
      before: authedWithPlan,
      assigns: {} as never,
    },
    async (c) => {
      const domain = await ownedDomain(principalOf(c).userId, c.params.domain_id)
      const entitlement = entitlementFrom(c)

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
