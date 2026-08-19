import { from } from "@atlas/db"
import { db } from "../db/index.ts"
import { forbidden, notFound } from "../errors/index.ts"
import { type Domain, domainAdmins, domains, users } from "../schema/index.ts"

/**
 * Who may act on what.
 *
 * Three grants, deliberately not one ladder:
 *
 * - **Owner** (`users.is_owner`) — the account that claimed the server. Exactly
 *   one, forever, enforced by a partial unique index.
 * - **System administrator** (`users.is_admin`) — acts on every domain on the
 *   instance. Granted and revoked by the owner.
 * - **Domain administrator** (`domain_admins`) — acts on the mailboxes of the
 *   domains they are named on, and on nothing else.
 *
 * Every check is a database read on the request rather than a claim carried in
 * the session, for the same reason `owner` in `api/pipes` is: a revoked grant
 * has to take effect on the next request, not when a two-week session expires.
 *
 * **Administering a domain is not owning it.** This module answers "may they
 * manage the mailboxes here", which is what gets delegated. Billing, plans,
 * transfers, deleting the domain, and changing who administers it stay with the
 * domain's owner and the instance owner — see `ownedDomain` for that question.
 * Widening this to cover those is not a small change to a boolean; it hands
 * somebody else's credit card and someone's mail to a delegate.
 */

export type Grant = {
  /** The instance owner, or an account carrying `is_admin`. */
  system: boolean
  /** This principal is `domains.user_id` for the domain in question. */
  owns: boolean
  /** Named in `domain_admins` for the domain in question. */
  administers: boolean
}

export const isSystemAdmin = async (userId: string): Promise<boolean> => {
  const row = await db().one<{ is_owner: boolean; is_admin: boolean; status: string }>(
    from(users)
      .select("is_owner", "is_admin", "status")
      .where((q) => q("id").equals(userId)),
  )
  // A suspended or terminated account keeps its flags in the row and loses the
  // authority they describe.
  if (row?.status !== "active") return false
  return Boolean(row.is_owner || row.is_admin)
}

export const grantFor = async (userId: string, domain: Domain): Promise<Grant> => {
  const system = await isSystemAdmin(userId)
  const owns = domain.user_id === userId
  if (system || owns) return { system, owns, administers: false }

  const row = await db().one<{ id: string }>(
    from(domainAdmins)
      .select("id")
      .where((q) => [q("domain_id").equals(domain.id), q("user_id").equals(userId)]),
  )
  return { system: false, owns: false, administers: Boolean(row) }
}

export const mayAdminister = (grant: Grant): boolean =>
  grant.system || grant.owns || grant.administers

/**
 * The domain, if this principal may manage its mailboxes.
 *
 * `notFound` rather than `forbidden` on a miss, matching what the ownership
 * checks already did: a caller who may not touch a domain should not be able to
 * learn it exists by the shape of the refusal.
 */
export const administeredDomain = async (userId: string, id: string): Promise<Domain> => {
  const domain = await db().one<Domain>(from(domains).where((q) => q("id").equals(id)))
  if (!domain) throw notFound("Domain not found.")
  if (!mayAdminister(await grantFor(userId, domain))) throw notFound("Domain not found.")
  return domain
}

/**
 * The domain, only for someone who owns it outright.
 *
 * The gate for everything a delegate must not reach: deleting the domain,
 * moving it to another account, and choosing who else administers it. A domain
 * administrator who could appoint domain administrators would be able to grant
 * themselves nothing new — but they could hand the domain's mail to a stranger,
 * and that is the owner's call.
 */
export const ownedDomain = async (userId: string, id: string): Promise<Domain> => {
  const domain = await db().one<Domain>(from(domains).where((q) => q("id").equals(id)))
  if (!domain) throw notFound("Domain not found.")
  const system = await isSystemAdmin(userId)
  if (!system && domain.user_id !== userId) throw notFound("Domain not found.")
  return domain
}

/** Every domain this principal may manage, owned and delegated alike. */
export const administeredDomainIds = async (userId: string): Promise<string[] | "all"> => {
  if (await isSystemAdmin(userId)) return "all"
  const rows = await db().all<{ domain_id: string }>(
    from(domainAdmins)
      .select("domain_id")
      .where((q) => q("user_id").equals(userId)),
  )
  return rows.map((r) => r.domain_id)
}

/**
 * The domains a *mailbox* administers.
 *
 * The webmail's management surface is built on this. It deliberately does not
 * consult `users` at all: a mailbox is not an account, holds no plan, owns
 * nothing, and reaches exactly the domains named against it here.
 */
export const domainsAdministeredByAddress = async (addressId: string): Promise<Domain[]> =>
  db().all<Domain>({
    text: `SELECT d.* FROM domain_admins da
             JOIN domains d ON d.id = da.domain_id
            WHERE da.address_id = $1
         ORDER BY d.name ASC`,
    values: [addressId],
  })

/**
 * The domain, if this mailbox administers it.
 *
 * `notFound` on a miss, like every other check here, so a delegate cannot map
 * the server by the shape of its refusals.
 */
export const addressAdministeredDomain = async (
  addressId: string,
  domainId: string,
): Promise<Domain> => {
  const row = await db().one<Domain>({
    text: `SELECT d.* FROM domain_admins da
             JOIN domains d ON d.id = da.domain_id
            WHERE da.address_id = $1 AND da.domain_id = $2`,
    values: [addressId, domainId],
  })
  if (!row) throw notFound("Domain not found.")
  return row
}

export const requireSystemAdmin = async (userId: string): Promise<void> => {
  if (!(await isSystemAdmin(userId))) {
    throw forbidden("Only an administrator of this server can do that.")
  }
}
