import { delR, getR, json, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { createApiKey, deleteApiKey, listApiKeys } from "../../../apikeys/index.ts"
import { db } from "../../../db/index.ts"
import { invalidParameter, notFound } from "../../../errors/index.ts"
import { apiKeyObject } from "../../../serialize/index.ts"
import { authed, principalOf } from "../../pipes/index.ts"

/**
 * Managing sending-API keys, from the panel only.
 *
 * A key cannot mint keys. Letting one would make every leaked key a way to
 * create replacements its owner does not know about, and revoking it would no
 * longer end the exposure.
 *
 * Keys are scoped to domains the account *owns*. A delegated domain
 * administrator manages mailboxes; sending as the domain is the owner's.
 */

const domainNames = async (userId: string): Promise<Map<string, string>> => {
  const rows = await db().all<{ id: string; name: string }>({
    text: "SELECT id, name FROM domains WHERE user_id = $1",
    values: [userId],
  })
  return new Map(rows.map((r) => [r.id, r.name]))
}

export const apiKeyRoutes: Route[] = [
  getR("/api/api-keys", { before: authed, assigns: {} as never }, async (c) => {
    const userId = principalOf(c).userId
    const [keys, names] = await Promise.all([listApiKeys(userId), domainNames(userId)])
    return json(c, 200, {
      object: "list",
      data: keys.map((key) =>
        apiKeyObject(key, { domain: key.domain_id ? (names.get(key.domain_id) ?? null) : null }),
      ),
    })
  }),

  postR(
    "/api/api-keys",
    {
      body: z.object({
        name: z.string().trim().min(1).max(100),
        permission: z.enum(["full_access", "sending_access"]).optional(),
        domain_id: z.string().uuid().nullish(),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const userId = principalOf(c).userId
      const permission = c.body.permission ?? "full_access"

      let domain: string | null = null
      if (c.body.domain_id) {
        if (permission !== "sending_access") {
          throw invalidParameter("A key restricted to one domain can only have sending access.")
        }
        // Owned by this account, not merely reachable by it. `ownedDomain` lets a
        // system administrator through for any domain, and a key scoped to a
        // domain its account cannot send from would be accepted here and refused
        // on every send.
        const names = await domainNames(userId)
        domain = names.get(c.body.domain_id) ?? null
        if (!domain) throw notFound("Domain not found.")
      }

      const { key, token } = await createApiKey({
        userId,
        name: c.body.name,
        permission,
        domainId: c.body.domain_id ?? null,
      })

      // The only time the token leaves this server.
      return json(c, 201, { ...apiKeyObject(key, { domain }), token })
    },
  ),

  delR(
    "/api/api-keys/:api_key_id",
    { params: z.object({ api_key_id: z.string().uuid() }), before: authed, assigns: {} as never },
    async (c) => {
      const deleted = await deleteApiKey(principalOf(c).userId, c.params.api_key_id)
      if (!deleted) throw notFound("API key not found.")
      return json(c, 200, { object: "api_key", id: c.params.api_key_id, deleted: true })
    },
  ),
]
