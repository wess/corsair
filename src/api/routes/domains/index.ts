import { from } from "@atlas/db"
import { delR, getR, json, patchR, postR, type Route, text } from "@atlas/server"
import { z } from "zod"
import {
  administeredDomain,
  administeredDomainIds,
  grantFor,
  ownedDomain,
} from "../../../access/index.ts"
import { config } from "../../../config/index.ts"
import { allColumns, db } from "../../../db/index.ts"
import { detectProvider, publishRecords } from "../../../dnsprovider/index.ts"
import {
  checkDomain,
  createDomain,
  normalizeDomain,
  syncRecords,
  zoneFile,
} from "../../../domains/index.ts"
import { conflict, invalidParameter, notFound } from "../../../errors/index.ts"
import { emit } from "../../../events/index.ts"
import { paginate, parsePageQuery } from "../../../pagination/index.ts"
import { requireFeature } from "../../../plans/index.ts"
import {
  type DkimKey,
  type Domain,
  type DomainRecord,
  dkimKeys,
  domainRecords,
  domains,
} from "../../../schema/index.ts"
import {
  dkimKeyObject,
  domainListItem,
  domainObject,
  domainRecordObject,
} from "../../../serialize/index.ts"
import { authed, authedWithPlan, entitlementFrom, principalOf } from "../../pipes/index.ts"

const domainParam = z.object({ domain_id: z.string().uuid() })

/**
 * Everything about the domain *itself* — its DNS, its keys, its settings, its
 * deletion — stays with whoever owns it, plus a system administrator.
 *
 * A domain administrator is deliberately not here. They were delegated the
 * mailboxes (see `routes/addresses`), and the one route below that they do
 * reach is the domain's own detail, because the panel cannot show them a
 * mailbox list without first showing them the domain it belongs to.
 */
const owned = ownedDomain

const recordsOf = (domainId: string): Promise<DomainRecord[]> =>
  db().all<DomainRecord>(
    from(domainRecords)
      .where((q) => q("domain_id").equals(domainId))
      .orderBy("position", "ASC"),
  )

const addressCount = async (domainId: string): Promise<number> => {
  const row = await db().one<{ count: string }>({
    text: "SELECT count(*)::text AS count FROM addresses WHERE domain_id = $1",
    values: [domainId],
  })
  return Number(row?.count ?? 0)
}

export const domainRoutes: Route[] = [
  getR("/api/domains", { before: authed, assigns: {} as never }, async (c) => {
    /**
     * Owned domains, plus any this account has been made an administrator of.
     *
     * A delegate who could manage a domain's mailboxes but could not see the
     * domain in their own list would have nowhere to start from — the panel is
     * built around picking a domain first.
     */
    const scope = await administeredDomainIds(principalOf(c).userId)
    const page = await paginate<Domain>({
      source: "domains",
      columns: "*",
      where:
        scope === "all"
          ? "true"
          : scope.length
            ? // Bun's Postgres driver does not bind a JS array to a Postgres
              // array; the list is expanded server-side from jsonb, and goes in
              // as-is because pre-stringifying makes a jsonb scalar.
              "(user_id = $1 OR id = ANY(SELECT jsonb_array_elements_text($2::jsonb)::uuid))"
            : "user_id = $1",
      values:
        scope === "all"
          ? []
          : scope.length
            ? [principalOf(c).userId, scope]
            : [principalOf(c).userId],
      searchColumns: ["name"],
      sortable: { name: "name", data_usage: "bytes_used", status: "status" },
      defaultSort: "name",
      query: parsePageQuery((c.query ?? {}) as Record<string, string>),
    })
    return json(c, 200, { ...page, data: page.data.map(domainListItem) })
  }),

  postR(
    "/api/domains",
    {
      body: z.object({ name: z.string().min(1).max(253) }),
      before: authedWithPlan,
      assigns: {} as never,
    },
    async (c) => {
      // Validated before the quota is consulted: "that is not a domain name" is
      // true regardless of the plan, and answering with an upgrade prompt for a
      // typo sends the customer down the wrong path entirely.
      normalizeDomain(c.body.name)

      const entitlement = entitlementFrom(c)
      if (entitlement.plan.max_domains !== null) {
        const row = await db().one<{ count: string }>({
          text: "SELECT count(*)::text AS count FROM domains WHERE user_id = $1",
          values: [principalOf(c).userId],
        })
        if (Number(row?.count ?? 0) >= entitlement.plan.max_domains) {
          throw conflict(
            `The ${entitlement.plan.name} plan allows ${entitlement.plan.max_domains} domain(s).`,
          )
        }
      }

      const created = await createDomain({
        userId: principalOf(c).userId,
        name: c.body.name,
      })

      // Check the records straight away — a customer who has already published
      // them (a re-add, or a domain moved between accounts) should not have to
      // wait for the periodic check.
      const { enqueueJob } = await import("../../../worker/index.ts")
      await enqueueJob({
        kind: "domain.verify",
        payload: { domain_id: created.domain.id },
        userId: principalOf(c).userId,
      }).catch(() => {})

      void emit({
        userId: principalOf(c).userId,
        domainId: created.domain.id,
        type: "domain.created",
        data: { domain: created.domain.name, status: created.domain.status },
      })

      return json(c, 201, domainObject(created.domain, created.records, { addressCount: 0 }))
    },
  ),

  getR(
    "/api/domains/:domain_id",
    { params: domainParam, before: authed, assigns: {} as never },
    async (c) => {
      const domain = await administeredDomain(principalOf(c).userId, c.params.domain_id)
      const fallback = domain.fallback_domain_id
        ? await db().one<Domain>(
            from(domains).where((q) => q("id").equals(domain.fallback_domain_id!)),
          )
        : null
      return json(
        c,
        200,
        domainObject(domain, await recordsOf(domain.id), {
          fallback,
          addressCount: await addressCount(domain.id),
          grant: await grantFor(principalOf(c).userId, domain),
        }),
      )
    },
  ),

  getR(
    "/api/domains/:domain_id/dns",
    { params: domainParam, before: authed, assigns: {} as never },
    async (c) => {
      const domain = await owned(principalOf(c).userId, c.params.domain_id)
      const records = await recordsOf(domain.id)
      return json(c, 200, {
        object: "dns_setup",
        domain: domain.name,
        status: domain.status,
        // Repeated here so the setup screen can name the provider without a
        // second call.
        provider_hint: {
          mx: config.mail.mx,
          smtp: config.mail.smtp,
          imap: config.mail.imap,
          pop: config.mail.pop,
        },
        records: records.map(domainRecordObject),
        last_checked_at: domain.last_checked_at?.toISOString() ?? null,
      })
    },
  ),

  getR(
    "/api/domains/:domain_id/dns/zone",
    { params: domainParam, before: authed, assigns: {} as never },
    async (c) => {
      const domain = await owned(principalOf(c).userId, c.params.domain_id)
      const body = zoneFile(domain, await recordsOf(domain.id))
      const response = text(c, 200, body)
      return {
        ...response,
        respHeaders: new Headers([
          ...response.respHeaders,
          ["content-type", "text/plain; charset=utf-8"],
          ["content-disposition", `attachment; filename="${domain.name}.zone"`],
        ]),
      }
    },
  ),

  /**
   * Which provider the domain resolves through, and whether Corsair can publish
   * to it. Cached on the row so the setup screen does not re-query on every
   * render, but re-detected when asked directly.
   */
  getR(
    "/api/domains/:domain_id/dns/provider",
    { params: domainParam, before: authed, assigns: {} as never },
    async (c) => {
      const domain = await owned(principalOf(c).userId, c.params.domain_id)
      const provider = await detectProvider(domain.name)

      if (provider.id !== domain.dns_provider) {
        await db()
          .execute(
            from(domains)
              .where((q) => q("id").equals(domain.id))
              .update({ dns_provider: provider.id, updated_at: new Date() }),
          )
          .catch(() => {})
      }

      return json(c, 200, { object: "dns_provider", ...provider })
    },
  ),

  /**
   * Publishes the whole record set through the provider's API.
   *
   * The token is used once and never stored. A DNS API token can usually
   * rewrite every record on every domain in an account, and keeping one on a
   * mail server to save a customer a paste is a bad trade.
   */
  postR(
    "/api/domains/:domain_id/dns/publish",
    {
      params: domainParam,
      body: z.object({
        provider: z.enum(["cloudflare", "digitalocean"]),
        token: z.string().min(10).max(500),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const domain = await owned(principalOf(c).userId, c.params.domain_id)
      const records = await recordsOf(domain.id)

      let result: Awaited<ReturnType<typeof publishRecords>>
      try {
        result = await publishRecords(c.body.provider, {
          domain: domain.name,
          records,
          token: c.body.token,
        })
      } catch (e) {
        // A rejected token or a missing zone is the customer's to fix, not a
        // server fault, so it comes back as a 400 with the provider's own words.
        throw invalidParameter((e as Error).message)
      }

      await db().execute(
        from(domains)
          .where((q) => q("id").equals(domain.id))
          .update({
            dns_provider: c.body.provider,
            dns_published_at: new Date(),
            updated_at: new Date(),
          }),
      )

      // Records published through an API are visible immediately, so the check
      // runs now rather than waiting for the periodic sweep.
      const checked = await checkDomain({ ...domain, dns_provider: c.body.provider })

      return json(c, 200, {
        object: "dns_publish",
        published: result.published,
        skipped: result.skipped,
        errors: result.errors,
        ready: checked.ready,
        domain: domainObject(checked.domain, checked.records),
      })
    },
  ),

  postR(
    "/api/domains/:domain_id/check",
    { params: domainParam, before: authed, assigns: {} as never },
    async (c) => {
      const domain = await owned(principalOf(c).userId, c.params.domain_id)
      const result = await checkDomain(domain)
      return json(c, 200, {
        object: "dns_check",
        ready: result.ready,
        domain: domainObject(result.domain, result.records),
      })
    },
  ),

  patchR(
    "/api/domains/:domain_id",
    {
      params: domainParam,
      body: z.object({
        dmarc_policy: z.enum(["none", "quarantine", "reject"]).optional(),
        self_service_enabled: z.boolean().optional(),
      }),
      before: authedWithPlan,
      assigns: {} as never,
    },
    async (c) => {
      const domain = await owned(principalOf(c).userId, c.params.domain_id)

      if (c.body.self_service_enabled !== undefined) {
        requireFeature(entitlementFrom(c), "self_service", "self-service features")
      }

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.dmarc_policy !== undefined) patch.dmarc_policy = c.body.dmarc_policy
      if (c.body.self_service_enabled !== undefined) {
        patch.self_service_enabled = c.body.self_service_enabled
      }

      const updated = await db().one<Domain>(
        from(domains)
          .where((q) => q("id").equals(domain.id))
          .update(patch)
          .returning(...allColumns(domains)),
      )

      // The DMARC policy is one of the published records, so changing it
      // changes what the customer has to have in DNS.
      const records =
        c.body.dmarc_policy !== undefined ? await syncRecords(updated!) : await recordsOf(domain.id)

      return json(c, 200, domainObject(updated!, records))
    },
  ),

  postR(
    "/api/domains/:domain_id/fallback",
    {
      params: domainParam,
      body: z.object({ fallback_domain: z.string().max(253).nullable() }),
      before: authedWithPlan,
      assigns: {} as never,
    },
    async (c) => {
      requireFeature(entitlementFrom(c), "fallback_domains", "fallback domains")
      const domain = await owned(principalOf(c).userId, c.params.domain_id)

      if (!c.body.fallback_domain) {
        const cleared = await db().one<Domain>(
          from(domains)
            .where((q) => q("id").equals(domain.id))
            .update({ fallback_domain_id: null, updated_at: new Date() })
            .returning(...allColumns(domains)),
        )
        return json(c, 200, domainObject(cleared!, await recordsOf(domain.id)))
      }

      const target = await db().one<Domain>(
        from(domains).where((q) => [
          q("name").equals(c.body.fallback_domain!.trim().toLowerCase()),
          q("user_id").equals(principalOf(c).userId),
        ]),
      )
      if (!target) throw invalidParameter("A fallback must be another domain on this account.")
      if (target.id === domain.id) throw invalidParameter("A domain cannot fall back to itself.")

      const updated = await db().one<Domain>(
        from(domains)
          .where((q) => q("id").equals(domain.id))
          .update({ fallback_domain_id: target.id, updated_at: new Date() })
          .returning(...allColumns(domains)),
      )
      return json(c, 200, domainObject(updated!, await recordsOf(domain.id), { fallback: target }))
    },
  ),

  getR(
    "/api/domains/:domain_id/keys",
    { params: domainParam, before: authed, assigns: {} as never },
    async (c) => {
      const domain = await owned(principalOf(c).userId, c.params.domain_id)
      const keys = await db().all<DkimKey>(
        from(dkimKeys)
          .where((q) => q("domain_id").equals(domain.id))
          .orderBy("position", "ASC"),
      )
      return json(c, 200, { object: "list", data: keys.map(dkimKeyObject) })
    },
  ),

  postR(
    "/api/domains/:domain_id/keys/:key_id/activate",
    {
      params: z.object({ domain_id: z.string().uuid(), key_id: z.string().uuid() }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const domain = await owned(principalOf(c).userId, c.params.domain_id)
      const key = await db().one<DkimKey>(
        from(dkimKeys).where((q) => [
          q("id").equals(c.params.key_id),
          q("domain_id").equals(domain.id),
        ]),
      )
      if (!key) throw notFound("Key not found.")

      // Deactivate first: the partial unique index allows exactly one active key
      // per domain, so flipping the new one on before the old one off fails.
      await db().execute(
        from(dkimKeys)
          .where((q) => q("domain_id").equals(domain.id))
          .update({ active: false }),
      )
      const activated = await db().one<DkimKey>(
        from(dkimKeys)
          .where((q) => q("id").equals(key.id))
          .update({ active: true, rotated_at: new Date() })
          .returning(...allColumns(dkimKeys)),
      )
      return json(c, 200, dkimKeyObject(activated!))
    },
  ),

  delR(
    "/api/domains/:domain_id",
    { params: domainParam, before: authed, assigns: {} as never },
    async (c) => {
      const domain = await owned(principalOf(c).userId, c.params.domain_id)
      await db().execute(
        from(domains)
          .where((q) => q("id").equals(domain.id))
          .del(),
      )
      void emit({
        userId: principalOf(c).userId,
        domainId: null,
        type: "domain.deleted",
        data: { domain: domain.name },
      })
      return json(c, 200, { object: "domain", id: domain.id, deleted: true })
    },
  ),
]
