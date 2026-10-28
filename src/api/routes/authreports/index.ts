import { getR, json, type Route } from "@wess/atlas/server"
import { z } from "zod"
import { administeredDomain } from "../../../access/index.ts"
import { dmarcSummary, tlsSummary } from "../../../authreports/index.ts"
import { dmarcSummaryObject, tlsSummaryObject } from "../../../serialize/index.ts"
import { authed, principalOf } from "../../pipes/index.ts"

/**
 * Received DMARC aggregate and TLS reports for one domain, totalled.
 *
 * Read-only, so a domain administrator sees them as well as the owner — the
 * same line the DNS records and their re-check sit on. Registered ahead of the
 * domain routes so `/api/domains/:domain_id/reports/...` is not taken by their
 * own `:domain_id` patterns.
 */

const params = z.object({ domain_id: z.string().uuid() })
const query = z.object({ days: z.coerce.number().int().min(1).max(180).optional() }).optional()

export const authReportRoutes: Route[] = [
  getR(
    "/api/domains/:domain_id/reports/dmarc",
    { params, query, before: authed, assigns: {} as never },
    async (c) => {
      const domain = await administeredDomain(principalOf(c).userId, c.params.domain_id)
      const days = c.query?.days ?? 30
      return json(c, 200, dmarcSummaryObject(days, await dmarcSummary(domain.id, days)))
    },
  ),

  getR(
    "/api/domains/:domain_id/reports/tls",
    { params, query, before: authed, assigns: {} as never },
    async (c) => {
      const domain = await administeredDomain(principalOf(c).userId, c.params.domain_id)
      const days = c.query?.days ?? 30
      return json(c, 200, tlsSummaryObject(days, await tlsSummary(domain.id, days)))
    },
  ),
]
