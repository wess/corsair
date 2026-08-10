import { from } from "@atlas/db"
import { getR, json, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { setPassword } from "../../../addresses/index.ts"
import { allColumns, db } from "../../../db/index.ts"
import { forbidden, invalidParameter, notFound } from "../../../errors/index.ts"
import { consumeToken, sendAddressRecovery } from "../../../notify/index.ts"
import { type Address, addresses, type Domain, domains } from "../../../schema/index.ts"
import { authed, principalOf, publicLimit } from "../../pipes/index.ts"

/**
 * Self-service address recovery.
 *
 * Lets the person who owns a mailbox reset its password without going through
 * the account owner — which is the whole point of hosting mail for a team
 * rather than for yourself. It is gated per domain because an account owner who
 * has not thought about it should not be handing out password resets by
 * default.
 *
 * The public half of this is unauthenticated by necessity: somebody who has
 * lost their mailbox password cannot sign in to ask for a reset.
 */

const mailboxOf = async (email: string): Promise<{ address: Address; domain: Domain } | null> => {
  const at = email.lastIndexOf("@")
  if (at <= 0) return null

  const domain = await db().one<Domain>(
    from(domains).where((q) => q("name").equals(email.slice(at + 1).toLowerCase())),
  )
  if (!domain) return null

  const address = await db().one<Address>(
    from(addresses).where((q) => [
      q("domain_id").equals(domain.id),
      q("local_part").equals(email.slice(0, at).toLowerCase()),
    ]),
  )
  return address ? { address, domain } : null
}

export const recoveryRoutes: Route[] = [
  /**
   * Always answers the same way, whatever the truth is. Distinguishing "no such
   * mailbox" from "recovery is off" from "sent" would turn this into a way to
   * enumerate every address on every domain the server hosts.
   */
  postR(
    "/api/recover/request",
    {
      body: z.object({ email: z.string().email().max(320) }),
      before: [publicLimit],
      assigns: {} as never,
    },
    async (c) => {
      const found = await mailboxOf(c.body.email)

      const eligible =
        found?.domain.self_service_enabled &&
        found.address.recovery_address &&
        !found.address.disabled &&
        (found.address.type === "standard" || found.address.type === "catchall")

      if (eligible) {
        await sendAddressRecovery({
          recoveryAddress: found.address.recovery_address!,
          mailbox: `${found.address.local_part}@${found.domain.name}`,
          addressId: found.address.id,
        }).catch((e) => console.error("[corsair] could not send a recovery link:", e))
      }

      return json(c, 202, {
        object: "address_recovery",
        sent: true,
        message:
          "If that mailbox exists and has recovery enabled, a link is on its way to its recovery address.",
      })
    },
  ),

  postR(
    "/api/recover/reset",
    {
      body: z.object({
        token: z.string().min(10).max(200),
        password: z.string().min(8).max(200),
      }),
      before: [publicLimit],
      assigns: {} as never,
    },
    async (c) => {
      const row = await consumeToken("address_recovery", c.body.token)
      if (!row?.address_id) throw invalidParameter("That link is invalid or has expired.")

      // Re-checked at redemption, not just at request: the account owner may
      // have turned recovery off in the hour since the link was sent.
      const address = await db().one<Address>(
        from(addresses).where((q) => q("id").equals(row.address_id!)),
      )
      if (!address) throw notFound("That mailbox no longer exists.")

      const domain = await db().one<Domain>(
        from(domains).where((q) => q("id").equals(address.domain_id)),
      )
      if (!domain?.self_service_enabled) {
        throw forbidden("Self-service recovery is not enabled for this domain.")
      }

      await setPassword(address.id, c.body.password)
      return json(c, 200, {
        object: "address_recovery",
        reset: true,
        mailbox: `${address.local_part}@${domain.name}`,
      })
    },
  ),

  /** Confirms a link is still good, so the page can say so before asking for a password. */
  getR(
    "/api/recover/check",
    {
      query: z.object({ token: z.string().max(200) }),
      before: [publicLimit],
      assigns: {} as never,
    },
    async (c) => {
      const row = await db().one<{ id: string }>({
        text: `SELECT id FROM tokens
                WHERE kind = 'address_recovery' AND used_at IS NULL AND expires_at > now()
                  AND token_hash = encode(digest($1, 'sha256'), 'hex')`,
        values: [c.query.token],
      })
      return json(c, 200, { object: "address_recovery", valid: Boolean(row) })
    },
  ),

  /** The owner sets the recovery destination for a mailbox. */
  postR(
    "/api/addresses/:address_id/recovery",
    {
      params: z.object({ address_id: z.string().uuid() }),
      body: z.object({ recovery_address: z.string().email().max(320).nullable() }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const owned = await db().one<Address & { domain_name: string }>({
        text: `SELECT a.*, d.name AS domain_name FROM addresses a
                 JOIN domains d ON d.id = a.domain_id
                WHERE a.id = $1 AND d.user_id = $2`,
        values: [c.params.address_id, principalOf(c).userId],
      })
      if (!owned) throw notFound("Address not found.")

      const next = c.body.recovery_address?.trim().toLowerCase() ?? null
      if (next && next === `${owned.local_part}@${owned.domain_name}`.toLowerCase()) {
        throw invalidParameter(
          "The recovery address has to be a different mailbox — a link sent to the mailbox you cannot get into is no help.",
        )
      }

      const saved = await db().one<Address>(
        from(addresses)
          .where((q) => q("id").equals(owned.id))
          .update({ recovery_address: next, updated_at: new Date() })
          .returning(...allColumns(addresses)),
      )
      return json(c, 200, {
        object: "address",
        id: saved!.id,
        recovery_address: saved!.recovery_address,
      })
    },
  ),
]
