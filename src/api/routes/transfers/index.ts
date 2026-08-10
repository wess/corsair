import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { from } from "@atlas/db"
import { delR, getR, json, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { config } from "../../../config/index.ts"
import { allColumns, db } from "../../../db/index.ts"
import { invalidParameter, notFound } from "../../../errors/index.ts"
import { paginate, parsePageQuery } from "../../../pagination/index.ts"
import { requireFeature } from "../../../plans/index.ts"
import {
  type Address,
  addresses,
  type Domain,
  domains,
  type Transfer,
  transfers,
} from "../../../schema/index.ts"
import { transferObject } from "../../../serialize/index.ts"
import { authed, authedWithPlan, entitlementFrom, principalOf } from "../../pipes/index.ts"

/**
 * The source password is somebody else's credential at another provider, held
 * only long enough to copy the mail. AES-GCM rather than a hash because it has
 * to be replayed at the source server, and cleared the moment the transfer
 * reaches a terminal state.
 */
const encryptPassword = (plain: string): string => {
  const key = createHash("sha256").update(config.jwtSecret).digest()
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const payload = cipher.update(plain, "utf8", "base64") + cipher.final("base64")
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${payload}`
}

const transferParam = z.object({ transfer_id: z.string().uuid() })

const emailOf = async (addressId: string): Promise<string | undefined> => {
  const row = await db().one<{ email: string }>({
    text: `SELECT a.local_part || '@' || d.name AS email FROM addresses a
             JOIN domains d ON d.id = a.domain_id WHERE a.id = $1`,
    values: [addressId],
  })
  return row?.email
}

export const transferRoutes: Route[] = [
  getR("/api/transfers", { before: authed, assigns: {} as never }, async (c) => {
    const page = await paginate<Transfer>({
      source: "transfers",
      columns: "*",
      where: "user_id = $1",
      values: [principalOf(c).userId],
      searchColumns: ["username", "server"],
      sortable: { username: "username", server: "server", status: "status" },
      defaultSort: "created_at",
      query: {
        ...parsePageQuery((c.query ?? {}) as Record<string, string>),
        direction: ((c.query ?? {}) as Record<string, string>).direction === "asc" ? "asc" : "desc",
      },
    })
    const data = await Promise.all(
      page.data.map(async (t) => transferObject(t, { email: await emailOf(t.address_id) })),
    )
    return json(c, 200, { ...page, data })
  }),

  postR(
    "/api/transfers",
    {
      body: z.object({
        server: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535).optional(),
        secure: z.boolean().optional(),
        username: z.string().min(1).max(320),
        password: z.string().min(1).max(500),
        destination_address_id: z.string().uuid(),
        message_limit: z.number().int().min(1).max(1_000_000).nullable().optional(),
        size_limit: z.number().int().min(1).nullable().optional(),
        newer_than: z.string().datetime().nullable().optional(),
        accepted_policy: z.boolean(),
      }),
      before: authedWithPlan,
      assigns: {} as never,
    },
    async (c) => {
      requireFeature(entitlementFrom(c), "transfers", "mailbox transfers")
      if (!c.body.accepted_policy) {
        throw invalidParameter("The transfer policy has to be accepted before a transfer starts.")
      }

      const destination = await db().one<Address & { domain_user: string }>({
        text: `SELECT a.*, d.user_id AS domain_user FROM addresses a
                 JOIN domains d ON d.id = a.domain_id
                WHERE a.id = $1 AND d.user_id = $2`,
        values: [c.body.destination_address_id, principalOf(c).userId],
      })
      if (!destination) throw invalidParameter("The destination address is not on this account.")
      if (destination.type === "alias" || destination.type === "group") {
        throw invalidParameter("Mail can only be transferred into a mailbox, not a forwarder.")
      }

      const row = await db().one<Transfer>(
        from(transfers)
          .insert({
            user_id: principalOf(c).userId,
            address_id: destination.id,
            server: c.body.server.trim(),
            port: c.body.port ?? 993,
            secure: c.body.secure ?? true,
            username: c.body.username.trim(),
            password_enc: encryptPassword(c.body.password),
            message_limit: c.body.message_limit ?? null,
            size_limit: c.body.size_limit ? BigInt(c.body.size_limit) : null,
            newer_than: c.body.newer_than ? new Date(c.body.newer_than) : null,
          })
          .returning(...allColumns(transfers)),
      )

      const { enqueueJob } = await import("../../../worker/index.ts")
      await enqueueJob({
        kind: "transfer.run",
        payload: { transfer_id: row!.id },
        userId: principalOf(c).userId,
      })

      return json(c, 201, transferObject(row!, { email: await emailOf(destination.id) }))
    },
  ),

  getR(
    "/api/transfers/:transfer_id",
    { params: transferParam, before: authed, assigns: {} as never },
    async (c) => {
      const row = await db().one<Transfer>(
        from(transfers).where((q) => [
          q("id").equals(c.params.transfer_id),
          q("user_id").equals(principalOf(c).userId),
        ]),
      )
      if (!row) throw notFound("Transfer not found.")
      return json(c, 200, transferObject(row, { email: await emailOf(row.address_id) }))
    },
  ),

  delR(
    "/api/transfers/:transfer_id",
    { params: transferParam, before: authed, assigns: {} as never },
    async (c) => {
      const row = await db().one<Transfer>(
        from(transfers).where((q) => [
          q("id").equals(c.params.transfer_id),
          q("user_id").equals(principalOf(c).userId),
        ]),
      )
      if (!row) throw notFound("Transfer not found.")

      // A running transfer is marked cancelled rather than deleted: the worker
      // checks the status between batches and stops, and whatever it already
      // copied stays copied.
      await db().execute(
        from(transfers)
          .where((q) => q("id").equals(row.id))
          .update({
            status: "cancelled",
            password_enc: null,
            finished_at: new Date(),
            updated_at: new Date(),
          }),
      )
      return json(c, 200, { object: "transfer", id: row.id, cancelled: true })
    },
  ),

  /** Mailboxes a transfer can target, for the destination picker. */
  getR("/api/transfers/destinations", { before: authed, assigns: {} as never }, async (c) => {
    const rows = await db().all<{ id: string; email: string }>({
      text: `SELECT a.id, a.local_part || '@' || d.name AS email
               FROM addresses a JOIN domains d ON d.id = a.domain_id
              WHERE d.user_id = $1 AND a.type IN ('standard', 'catchall')
              ORDER BY email`,
      values: [principalOf(c).userId],
    })
    return json(c, 200, { object: "list", data: rows })
  }),
]

export const transferTables = { transfers, addresses, domains }
export type { Domain }
