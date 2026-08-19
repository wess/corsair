import { from } from "@atlas/db"
import { db } from "../db/index.ts"
import { type Address, addresses, type Domain, domains, type User, users } from "../schema/index.ts"

/**
 * Things that need somebody's attention, computed rather than stored.
 *
 * The rule that keeps these worth reading: **a notice is only raised for
 * somebody who can act on it, and it disappears when they have.** There is no
 * dismiss button and no `dismissed_at` column, because a notice that can be
 * dismissed without the underlying thing changing is a notice people learn to
 * dismiss. Anything a viewer cannot fix is not their alert — it belongs to
 * whoever can, and is raised there instead.
 *
 * `action.target` is a client-side handle, not a URL, because the two surfaces
 * mean different things by "go there": the panel navigates to a route, and the
 * webmail opens a dialog it already has.
 */

export type Notice = {
  /** Stable across renders so a client can key on it. */
  id: string
  level: "info" | "warn"
  title: string
  body: string
  action?: { label: string; target: string }
}

// ------------------------------------------------------------- a mailbox --

/**
 * Notices for somebody signed in to the webmail.
 *
 * Deliberately few. This is the inbox of a person who did not ask to administer
 * anything, and a banner they cannot clear is worse than no banner.
 */
export const mailboxNotices = (address: Address, domain: Domain): Notice[] => {
  const notices: Notice[] = []

  /**
   * A mailbox with its own password and nowhere to send a reset is one
   * forgotten password away from needing the domain's owner. Only raised when
   * the domain actually allows recovery — otherwise setting an address here
   * would change nothing, and telling somebody to do something that changes
   * nothing is how banners get ignored.
   */
  if (!address.user_id && !address.recovery_address && domain.self_service_enabled) {
    notices.push({
      id: "recovery_missing",
      level: "warn",
      title: "No way to reset this password",
      body: `If you forget the password for this mailbox, there is nowhere to send a reset link. Add another address you can reach — not ${address.local_part}@${domain.name}.`,
      action: { label: "Add a recovery address", target: "settings" },
    })
  }

  return notices
}

// ------------------------------------------------------------- an account --

const countAddresses = async (domainId: string): Promise<number> => {
  const row = await db().one<{ count: string }>({
    text: "SELECT count(*)::text AS count FROM addresses WHERE domain_id = $1",
    values: [domainId],
  })
  return Number(row?.count ?? 0)
}

/**
 * Notices for somebody signed in to the control panel.
 *
 * Scoped to what this account owns. A system administrator does not get every
 * domain on the box here — an alert list that grows with somebody else's estate
 * is a list nobody reads.
 */
export const accountNotices = async (userId: string): Promise<Notice[]> => {
  const notices: Notice[] = []

  const user = await db().one<User>(from(users).where((q) => q("id").equals(userId)))
  if (!user) return notices

  if (!user.email_verified_at) {
    notices.push({
      id: "email_unverified",
      level: "warn",
      title: "Your email address is not verified",
      body: "Password resets and account notices go to it, so an unverified address means losing this account is unrecoverable.",
      action: { label: "Account settings", target: "/account" },
    })
  }

  const owned = await db().all<Domain>(
    from(domains)
      .where((q) => q("user_id").equals(userId))
      .orderBy("name", "ASC"),
  )

  for (const domain of owned) {
    if (domain.status !== "active") {
      notices.push({
        id: `domain_unverified:${domain.id}`,
        level: "warn",
        title: `${domain.name} is not verified`,
        body: "Its DNS records are incomplete, so mail for it will not be delivered here.",
        action: { label: "Check DNS", target: `/domains/${domain.id}?tab=dns` },
      })
      // One notice per domain: "it is not set up" already covers "it has no
      // mailboxes", and two rows for one unfinished job reads as two jobs.
      continue
    }

    if ((await countAddresses(domain.id)) === 0) {
      notices.push({
        id: `domain_empty:${domain.id}`,
        level: "warn",
        title: `${domain.name} has no mailboxes`,
        body: "Every message sent to it is rejected with 550 No such user here, even though the domain itself is verified.",
        action: { label: "Add a mailbox", target: `/domains/${domain.id}?tab=mailboxes` },
      })
      continue
    }

    /**
     * Recovery switched on for a domain whose mailboxes have nowhere to send a
     * link is the half-configured state that makes "Forgot your password?" a
     * dead end. The mailbox holder can now fix it themselves, but they will not
     * know to — so it is raised to the person who turned the switch on.
     */
    if (domain.self_service_enabled) {
      const stranded = await db().all<Address>(
        from(addresses).where((q) => [
          q("domain_id").equals(domain.id),
          q("recovery_address").isNull(),
          q("user_id").isNull(),
          q("type").inList(["standard", "catchall"]),
        ]),
      )
      if (stranded.length) {
        notices.push({
          id: `recovery_gap:${domain.id}`,
          level: "info",
          title: `${stranded.length} mailbox${stranded.length === 1 ? "" : "es"} on ${domain.name} cannot self-recover`,
          body: "Recovery is enabled for this domain, but these have no address to send a reset link to, so a forgotten password still comes to you.",
          action: { label: "Review mailboxes", target: `/domains/${domain.id}?tab=mailboxes` },
        })
      }
    }
  }

  return notices
}
