import { from } from "@atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { allColumns, db } from "../../../db/index.ts"
import { invalidParameter, notFound } from "../../../errors/index.ts"
import { paginate, parsePageQuery } from "../../../pagination/index.ts"
import { requireFeature } from "../../../plans/index.ts"
import { type Filter, filters } from "../../../schema/index.ts"
import { filterObject } from "../../../serialize/index.ts"
import * as sieve from "../../../sieve/index.ts"
import { authed, authedWithPlan, entitlementFrom, principalOf } from "../../pipes/index.ts"

const filterParam = z.object({ filter_id: z.string().uuid() })

const owned = async (userId: string, id: string): Promise<Filter> => {
  const row = await db().one<Filter>(
    from(filters).where((q) => [q("id").equals(id), q("user_id").equals(userId)]),
  )
  if (!row) throw notFound("Filter not found.")
  return row
}

export const filterRoutes: Route[] = [
  getR("/api/filters", { before: authed, assigns: {} as never }, async (c) => {
    const page = await paginate<Filter>({
      source: "filters",
      columns: "*",
      where: "user_id = $1",
      values: [principalOf(c).userId],
      searchColumns: ["name"],
      sortable: { name: "name", size: "size" },
      defaultSort: "name",
      query: parsePageQuery((c.query ?? {}) as Record<string, string>),
    })
    return json(c, 200, { ...page, data: page.data.map(filterObject) })
  }),

  postR(
    "/api/filters/validate",
    { body: z.object({ script: z.string().max(64_000) }), before: authed, assigns: {} as never },
    async (c) => {
      // Deliberately available on every plan: a customer should be able to check
      // a script before being asked to pay for the ability to save it.
      const result = sieve.compile(c.body.script)
      return json(c, 200, {
        object: "filter_validation",
        ok: result.ok,
        error: result.ok ? null : result.error,
      })
    },
  ),

  postR(
    "/api/filters",
    {
      body: z.object({ name: z.string().min(1).max(120), script: z.string().max(64_000) }),
      before: authedWithPlan,
      assigns: {} as never,
    },
    async (c) => {
      requireFeature(entitlementFrom(c), "custom_filters", "custom filters")

      const compiled = sieve.compile(c.body.script)
      if (!compiled.ok) throw invalidParameter(`That script does not compile: ${compiled.error}`)

      const row = await db().one<Filter>(
        from(filters)
          .insert({
            user_id: principalOf(c).userId,
            name: c.body.name.trim(),
            script: c.body.script,
            size: c.body.script.length,
          })
          .returning(...allColumns(filters)),
      )
      return json(c, 201, filterObject(row!))
    },
  ),

  getR(
    "/api/filters/:filter_id",
    { params: filterParam, before: authed, assigns: {} as never },
    async (c) => json(c, 200, filterObject(await owned(principalOf(c).userId, c.params.filter_id))),
  ),

  patchR(
    "/api/filters/:filter_id",
    {
      params: filterParam,
      body: z.object({
        name: z.string().min(1).max(120).optional(),
        script: z.string().max(64_000).optional(),
      }),
      before: authedWithPlan,
      assigns: {} as never,
    },
    async (c) => {
      requireFeature(entitlementFrom(c), "custom_filters", "custom filters")
      const filter = await owned(principalOf(c).userId, c.params.filter_id)

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.name !== undefined) patch.name = c.body.name.trim()
      if (c.body.script !== undefined) {
        const compiled = sieve.compile(c.body.script)
        if (!compiled.ok) throw invalidParameter(`That script does not compile: ${compiled.error}`)
        patch.script = c.body.script
        patch.size = c.body.script.length
        // A previous runtime failure is cleared by a successful save; leaving it
        // set would show a stale error against a script that now works.
        patch.compile_error = null
      }

      const row = await db().one<Filter>(
        from(filters)
          .where((q) => q("id").equals(filter.id))
          .update(patch)
          .returning(...allColumns(filters)),
      )
      return json(c, 200, filterObject(row!))
    },
  ),

  delR(
    "/api/filters/:filter_id",
    { params: filterParam, before: authed, assigns: {} as never },
    async (c) => {
      const filter = await owned(principalOf(c).userId, c.params.filter_id)
      // Addresses referencing it are set to no filter by the FK, so deleting a
      // filter never stops mail from being delivered.
      await db().execute(
        from(filters)
          .where((q) => q("id").equals(filter.id))
          .del(),
      )
      return json(c, 200, { object: "filter", id: filter.id, deleted: true })
    },
  ),
]
