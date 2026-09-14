import { delR, getR, json, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { db } from "../../../db/index.ts"
import { notFound } from "../../../errors/index.ts"
import { paginate, parsePageQuery } from "../../../pagination/index.ts"
import type { Suppression } from "../../../schema/index.ts"
import { suppressionObject } from "../../../serialize/index.ts"
import { normalizeRecipient, removeSuppression, suppress } from "../../../suppressions/index.ts"
import { authed, principalOf } from "../../pipes/index.ts"

/**
 * The account's suppression list, from the panel.
 *
 * Removing an entry is how an address that bounced once — a mailbox that was
 * full, a domain that lapsed and came back — gets mail from the sending API
 * again. Adding one by hand covers the person who asked by phone.
 */

export const suppressionRoutes: Route[] = [
  getR(
    "/api/suppressions",
    { query: z.record(z.string()).optional(), before: authed, assigns: {} as never },
    async (c) => {
      const page = await paginate<Suppression>({
        source: "suppressions",
        columns: "*",
        where: "user_id = $1",
        values: [principalOf(c).userId],
        searchColumns: ["email", "reason", "detail"],
        sortable: { email: "email", reason: "reason", created: "created_at" },
        defaultSort: "created_at",
        query: parsePageQuery((c.query ?? {}) as Record<string, string>),
      })
      return json(c, 200, { ...page, data: page.data.map(suppressionObject) })
    },
  ),

  postR(
    "/api/suppressions",
    {
      body: z.object({ email: z.string().email().max(320), detail: z.string().max(500).nullish() }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const userId = principalOf(c).userId
      await suppress({
        userId,
        address: c.body.email,
        reason: "manual",
        detail: c.body.detail ?? null,
      })
      // An address already on the list keeps its original reason, and adding
      // it again is not an error — the caller's intent is already true.
      const row = await db().one<Suppression>({
        text: "SELECT * FROM suppressions WHERE user_id = $1 AND email = $2",
        values: [userId, normalizeRecipient(c.body.email)],
      })
      return json(c, 201, suppressionObject(row!))
    },
  ),

  delR(
    "/api/suppressions/:suppression_id",
    {
      params: z.object({ suppression_id: z.string().uuid() }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const removed = await removeSuppression(principalOf(c).userId, c.params.suppression_id)
      if (!removed) throw notFound("Suppression not found.")
      return json(c, 200, { object: "suppression", id: c.params.suppression_id, deleted: true })
    },
  ),
]
