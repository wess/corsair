import { from } from "@atlas/db"
import { delR, getR, json, patchR, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { addressAdministeredDomain, domainsAdministeredByAddress } from "../../../access/index.ts"
import {
  createAddress,
  deleteAddress,
  destinationsOf,
  setPassword,
} from "../../../addresses/index.ts"
import { allColumns, db } from "../../../db/index.ts"
import { conflict, invalidParameter, notFound } from "../../../errors/index.ts"
import { emit } from "../../../events/index.ts"
import { entitlementOf } from "../../../plans/index.ts"
import { type Address, addresses, type Domain } from "../../../schema/index.ts"
import { addressObject } from "../../../serialize/index.ts"
import { identityOf, mailed } from "../../pipes/index.ts"

/**
 * Managing a domain's mailboxes from inside the webmail.
 *
 * The person who runs a client's mail is a mailbox on that domain, not a panel
 * account. Sending them to `/app` meant a second identity, a second password,
 * and a control panel full of billing, plans and transfers that are not theirs.
 * This is the same job, in the application they already use, reached with the
 * credential they already have.
 *
 * **This is not the control panel and must not grow into it.** Every route below
 * is authorised by a *mailbox* session and scoped to the domains that mailbox is
 * named against in `domain_admins`. It manages mailboxes. It cannot see billing,
 * touch DNS, delete a domain, appoint another administrator, or reach a domain
 * the session's address is not named on — and `issueMailSession` still refuses
 * this credential at `/app` entirely.
 */

const domainParam = z.object({ domain_id: z.string().uuid() })
const addressParam = z.object({ address_id: z.string().uuid() })

/** The address being managed, proven to be on a domain this session administers. */
const managed = async (
  actingAddressId: string,
  addressId: string,
): Promise<{ address: Address; domain: Domain }> => {
  const address = await db().one<Address>(from(addresses).where((q) => q("id").equals(addressId)))
  if (!address) throw notFound("Mailbox not found.")
  const domain = await addressAdministeredDomain(actingAddressId, address.domain_id).catch(
    () => null,
  )
  if (!domain) throw notFound("Mailbox not found.")
  return { address, domain }
}

export const mailAdminRoutes: Route[] = [
  /**
   * The domains this mailbox administers.
   *
   * An empty list is the ordinary answer for almost every mailbox, and it is
   * what the client uses to decide whether to show the Users section at all.
   */
  getR("/api/mail/admin/domains", { before: mailed, assigns: {} as never }, async (c) => {
    const rows = await domainsAdministeredByAddress(identityOf(c).address.id)
    return json(c, 200, {
      object: "list",
      data: rows.map((d) => ({ object: "domain", id: d.id, name: d.name, status: d.status })),
    })
  }),

  getR(
    "/api/mail/admin/domains/:domain_id/users",
    { params: domainParam, before: mailed, assigns: {} as never },
    async (c) => {
      const domain = await addressAdministeredDomain(identityOf(c).address.id, c.params.domain_id)
      const rows = await db().all<Address>(
        from(addresses)
          .where((q) => q("domain_id").equals(domain.id))
          .orderBy("local_part", "ASC"),
      )
      return json(c, 200, {
        object: "list",
        data: await Promise.all(
          rows.map(async (a) =>
            addressObject(a, {
              domain,
              destinations: (await destinationsOf(a.id)).map((d) => d.destination),
            }),
          ),
        ),
      })
    },
  ),

  postR(
    "/api/mail/admin/domains/:domain_id/users",
    {
      params: domainParam,
      body: z.object({
        local_part: z.string().min(1).max(64),
        type: z.enum(["standard", "alias", "group"]),
        name: z.string().max(120).nullable().optional(),
        password: z.string().min(8).max(200).optional(),
        destinations: z.array(z.string().email().max(320)).max(50).optional(),
      }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const domain = await addressAdministeredDomain(identityOf(c).address.id, c.params.domain_id)

      /**
       * The *owner's* plan is what limits this, not the delegate's — a delegate
       * has no plan of their own. Reading it from the session instead would let
       * anyone with a mailbox add addresses past the limit the domain's owner is
       * actually paying for.
       */
      const entitlement = await entitlementOf(domain.user_id)
      if (entitlement.plan.max_addresses !== null) {
        const row = await db().one<{ count: string }>({
          text: `SELECT count(*)::text AS count FROM addresses a
                   JOIN domains d ON d.id = a.domain_id WHERE d.user_id = $1`,
          values: [domain.user_id],
        })
        if (Number(row?.count ?? 0) >= entitlement.plan.max_addresses) {
          throw conflict(
            `This domain's plan allows ${entitlement.plan.max_addresses} address(es). Ask its owner to upgrade.`,
          )
        }
      }

      /**
       * No `use_account_password` here, and no `ownerId`.
       *
       * That flag binds a mailbox to a panel account's credential, and the only
       * account a delegate could name is one they do not control. A mailbox
       * created here always gets its own password — which is also the only kind
       * of password the person receiving it can be told.
       */
      const created = await createAddress({
        domainId: domain.id,
        localPart: c.body.local_part,
        type: c.body.type,
        name: c.body.name ?? null,
        password: c.body.password ?? null,
        destinations: c.body.destinations,
      })

      void emit({
        userId: domain.user_id,
        domainId: domain.id,
        type: "address.created",
        data: {
          address_id: created.address.id,
          local_part: created.address.local_part,
          by_mailbox: identityOf(c).email,
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

  patchR(
    "/api/mail/admin/users/:address_id",
    {
      params: addressParam,
      body: z.object({
        name: z.string().max(120).nullable().optional(),
        disabled: z.boolean().optional(),
      }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const { address, domain } = await managed(identityOf(c).address.id, c.params.address_id)

      // Disabling your own mailbox from inside it locks you out of the surface
      // you would use to undo it.
      if (c.body.disabled === true && address.id === identityOf(c).address.id) {
        throw invalidParameter("You cannot disable the mailbox you are signed in to.")
      }

      const patch: Record<string, unknown> = { updated_at: new Date() }
      if (c.body.name !== undefined) patch.name = c.body.name
      if (c.body.disabled !== undefined) patch.disabled = c.body.disabled

      const updated = await db().one<Address>(
        from(addresses)
          .where((q) => q("id").equals(address.id))
          .update(patch)
          .returning(...allColumns(addresses)),
      )
      return json(c, 200, addressObject(updated!, { domain }))
    },
  ),

  postR(
    "/api/mail/admin/users/:address_id/password",
    {
      params: addressParam,
      body: z.object({ password: z.string().min(8).max(200) }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const { address, domain } = await managed(identityOf(c).address.id, c.params.address_id)
      if (address.type === "alias" || address.type === "group") {
        throw invalidParameter("Forwarding addresses have no password.")
      }

      // `setPassword` refuses a mailbox whose credential is a panel account's,
      // which is the right answer here too: that password is not this domain's
      // to reset.
      await setPassword(address.id, c.body.password)

      void emit({
        userId: domain.user_id,
        domainId: domain.id,
        type: "address.password_changed",
        data: {
          address_id: address.id,
          local_part: address.local_part,
          by_mailbox: identityOf(c).email,
        },
      })
      return json(c, 200, { object: "address", id: address.id, password_changed: true })
    },
  ),

  delR(
    "/api/mail/admin/users/:address_id",
    { params: addressParam, before: mailed, assigns: {} as never },
    async (c) => {
      const { address, domain } = await managed(identityOf(c).address.id, c.params.address_id)

      // Deleting a mailbox destroys its mail. Doing it to your own, from your
      // own webmail, is never what was meant.
      if (address.id === identityOf(c).address.id) {
        throw invalidParameter("You cannot delete the mailbox you are signed in to.")
      }

      await deleteAddress(address.id)
      void emit({
        userId: domain.user_id,
        domainId: domain.id,
        type: "address.deleted",
        data: {
          address_id: address.id,
          local_part: address.local_part,
          by_mailbox: identityOf(c).email,
        },
      })
      return json(c, 200, { object: "address", id: address.id, deleted: true })
    },
  ),
]
