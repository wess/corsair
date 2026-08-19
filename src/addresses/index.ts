import { from } from "@atlas/db"
import { hashPassword } from "../auth/index.ts"
import { allColumns, db, num } from "../db/index.ts"
import { conflict, invalidParameter, notFound } from "../errors/index.ts"
import { uidValidity } from "../ids/index.ts"
import {
  type Address,
  type AddressDestination,
  addressDestinations,
  addresses,
  type Domain,
  domains,
  type Folder,
  folders,
  users,
} from "../schema/index.ts"

export type AddressType = "standard" | "alias" | "catchall" | "group"

/**
 * The addresses a hosted domain is not allowed to refuse.
 *
 * `postmaster` is required by RFC 5321 §4.5.1; `abuse` by RFC 2142. The second
 * is the one that matters operationally — blocklist operators and ISP abuse
 * desks reach an installation through it, so a domain that 550s `abuse@` is
 * unreachable at exactly the moment reachability decides whether the MX keeps
 * delivering anywhere.
 *
 * These resolve as a fallback instead of being written as rows when a domain is
 * created, which is the deliberate part. A row can be deleted, putting the
 * domain back out of compliance silently, and rows would only ever cover
 * domains onboarded after the change — every domain already hosted would need a
 * backfill. A fallback covers all of them at once, and an address the customer
 * creates still wins, because the exact-match lookup runs first.
 */
export const ROLE_ACCOUNTS: readonly string[] = ["postmaster", "abuse"]

// RFC 5321 allows far stranger local parts than this, including quoted strings
// with spaces. Refusing them costs nothing real and avoids a class of parsing
// bug in every downstream consumer.
const LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/

export const normalizeLocalPart = (input: string): string => {
  const value = input.trim().toLowerCase().replace(/@.*$/, "")
  if (!LOCAL_PART.test(value)) {
    throw invalidParameter(
      `"${input}" is not a valid mailbox name. Use letters, numbers, and . _ + -`,
    )
  }
  return value
}

export const emailOf = (address: Address, domain: Domain): string =>
  `${address.local_part}@${domain.name}`

// ------------------------------------------------------------- provision --

/**
 * The folders every new mailbox gets. IMAP clients will create these themselves
 * if they are missing, but each client picks its own names — one ends up with
 * "Sent" and "Sent Items" and "Sent Messages" in the same account. Creating
 * them up front with the RFC 6154 special-use attributes means every client
 * finds the folder it was going to make.
 */
const DEFAULT_FOLDERS: { name: string; specialUse: string | null }[] = [
  { name: "INBOX", specialUse: "inbox" },
  { name: "Drafts", specialUse: "drafts" },
  { name: "Sent", specialUse: "sent" },
  { name: "Junk", specialUse: "junk" },
  { name: "Trash", specialUse: "trash" },
  { name: "Archive", specialUse: "archive" },
]

export const provisionFolders = async (addressId: string): Promise<Folder[]> => {
  const out: Folder[] = []
  for (const spec of DEFAULT_FOLDERS) {
    const row = await db().one<Folder>(
      from(folders)
        .insert({
          address_id: addressId,
          name: spec.name,
          special_use: spec.specialUse,
          uid_validity: uidValidity(),
        })
        .returning(...allColumns(folders)),
    )
    if (row) out.push(row)
  }
  return out
}

export const inboxOf = async (addressId: string): Promise<Folder> => {
  const row = await db().one<Folder>(
    from(folders).where((q) => [q("address_id").equals(addressId), q("name").equals("INBOX")]),
  )
  if (row) return row
  // A mailbox with no INBOX is a broken invariant, not a user error — but
  // recreating it beats refusing the delivery.
  const created = await db().one<Folder>(
    from(folders)
      .insert({
        address_id: addressId,
        name: "INBOX",
        special_use: "inbox",
        uid_validity: uidValidity(),
      })
      .returning(...allColumns(folders)),
  )
  if (!created) throw notFound("Mailbox has no INBOX.")
  return created
}

export const folderBySpecialUse = async (
  addressId: string,
  specialUse: string,
): Promise<Folder | null> =>
  db().one<Folder>(
    from(folders).where((q) => [
      q("address_id").equals(addressId),
      q("special_use").equals(specialUse),
    ]),
  )

// ---------------------------------------------------------------- create --

export type CreateAddressInput = {
  domainId: string
  localPart: string
  type: AddressType
  name?: string | null
  password?: string | null
  destinations?: string[]
  filterId?: string | null
  /**
   * Create this mailbox signed in with the owner's account password rather than
   * one of its own. `ownerId` must be the account that owns the domain — every
   * route setting this has already proved that.
   */
  useAccountPassword?: boolean
  ownerId?: string | null
}

/**
 * The control-panel account this mailbox *is*, if any.
 *
 * A person who signs up as `me@example.com` and then creates the mailbox
 * `me@example.com` on their own domain is one person, and asking them to hold
 * two passwords for it was the single most common way a first client setup
 * went wrong. Linked, the mailbox has no password of its own and every protocol
 * verifies against the account's.
 *
 * The domain-ownership condition is load-bearing and not a formality. Without
 * it, anyone could register a panel account as `ceo@some-company.com` before
 * that company added its domain, and the mailbox would silently authenticate
 * against the squatter's password the moment it was created. Requiring that the
 * account already owns the domain means the only account that can be linked is
 * one that could read the mail anyway.
 */
const accountFor = async (domainId: string, localPart: string): Promise<string | null> => {
  const domain = await db().one<Domain>(from(domains).where((q) => q("id").equals(domainId)))
  if (!domain) return null

  const owner = await db().one<{ id: string; email: string }>(
    from(users)
      .select("id", "email")
      .where((q) => q("id").equals(domain.user_id)),
  )
  if (!owner) return null

  return owner.email.toLowerCase() === `${localPart}@${domain.name}`.toLowerCase() ? owner.id : null
}

export const createAddress = async (
  input: CreateAddressInput,
): Promise<{ address: Address; destinations: AddressDestination[] }> => {
  const localPart = normalizeLocalPart(input.localPart)
  const needsDestinations = input.type === "alias" || input.type === "group"
  const isMailbox = input.type === "standard" || input.type === "catchall"

  // Resolved before the password check: a mailbox that is its owner's own
  // account already has a password, and demanding a second one is the thing
  // this is meant to stop.
  //
  // `useAccountPassword` is the explicit form, for the common case where the
  // panel sign-in address and the mailbox address are simply different — the
  // automatic match only fires when they are identical.
  const userId = isMailbox
    ? ((input.useAccountPassword ? (input.ownerId ?? null) : null) ??
      (await accountFor(input.domainId, localPart)))
    : null

  if (isMailbox && !input.password && !userId) {
    throw invalidParameter("A mailbox needs a password.")
  }
  if (needsDestinations && !input.destinations?.length) {
    throw invalidParameter(
      input.type === "alias"
        ? "An alias needs a destination address."
        : "A group needs at least one recipient.",
    )
  }
  if (input.type === "alias" && (input.destinations?.length ?? 0) > 1) {
    throw invalidParameter("An alias forwards to one address. Use a group for several.")
  }

  const existing = await db().one<{ id: string }>(
    from(addresses)
      .select("id")
      .where((q) => [q("domain_id").equals(input.domainId), q("local_part").equals(localPart)]),
  )
  if (existing) throw conflict(`${localPart} already exists on this domain.`)

  if (input.type === "catchall") {
    const other = await db().one<{ id: string }>(
      from(addresses)
        .select("id")
        .where((q) => [q("domain_id").equals(input.domainId), q("type").equals("catchall")]),
    )
    if (other) throw conflict("This domain already has a catch-all address.")
  }

  const address = (await db().one<Address>(
    from(addresses)
      .insert({
        domain_id: input.domainId,
        local_part: localPart,
        type: input.type,
        name: input.name ?? null,
        user_id: userId,
        // A linked mailbox deliberately stores nothing here. Two hashes for one
        // person is how they drift apart.
        password_hash: userId ? null : input.password ? await hashPassword(input.password) : null,
        filter_id: input.filterId ?? null,
        password_changed_at: input.password ? new Date() : null,
      })
      .returning(...allColumns(addresses)),
  ))!

  if (isMailbox) await provisionFolders(address.id)

  const destinations: AddressDestination[] = []
  for (const [index, destination] of (input.destinations ?? []).entries()) {
    const row = await db().one<AddressDestination>(
      from(addressDestinations)
        .insert({
          address_id: address.id,
          destination: destination.trim().toLowerCase(),
          position: index,
        })
        .returning(...allColumns(addressDestinations)),
    )
    if (row) destinations.push(row)
  }

  return { address, destinations }
}

export const destinationsOf = (addressId: string): Promise<AddressDestination[]> =>
  db().all<AddressDestination>(
    from(addressDestinations)
      .where((q) => q("address_id").equals(addressId))
      .orderBy("position", "ASC"),
  )

/**
 * Sets a mailbox's own password.
 *
 * Refuses on a mailbox linked to a control-panel account. Writing a hash there
 * would silently re-split a credential that was deliberately merged: the
 * account password would keep working, the new one would not, and nothing would
 * say why. The account password is the one to change.
 */
export const setPassword = async (addressId: string, password: string): Promise<void> => {
  const address = await db().one<Address>(from(addresses).where((q) => q("id").equals(addressId)))
  if (!address) throw notFound("That address does not exist.")
  if (address.user_id) {
    throw invalidParameter(
      "This mailbox signs in with your account password. Change it in Account settings and it changes here too.",
    )
  }

  await db().execute(
    from(addresses)
      .where((q) => q("id").equals(addressId))
      .update({
        password_hash: await hashPassword(password),
        password_changed_at: new Date(),
        updated_at: new Date(),
      }),
  )
}

/**
 * Makes a mailbox sign in with its owner's account password.
 *
 * The caller must already own the domain — every route reaching this has gone
 * through `ownedAddress`, which is the same condition `accountFor` enforces
 * when a link is made automatically. An account can back several of its own
 * mailboxes; they all open with the one password, which is the point.
 *
 * The mailbox's own hash is cleared rather than kept as a fallback. Leaving it
 * would mean two working passwords where the panel shows one, and revoking the
 * account password would not revoke mail access.
 */
/**
 * Removes a mailbox and gives its space back to the domain.
 *
 * The cascade takes the messages, but `domains.bytes_used` is a running total
 * maintained by the delivery path — nothing recomputes it — so a delete that
 * skips the second statement leaves the domain permanently billed for mail that
 * no longer exists. It lives here rather than in a route because two surfaces
 * delete mailboxes now, and the one that forgot would be silently wrong.
 */
export const deleteAddress = async (addressId: string): Promise<void> => {
  const address = await db().one<Address>(from(addresses).where((q) => q("id").equals(addressId)))
  if (!address) throw notFound("That address does not exist.")

  const bytes = num(address.bytes_used)
  await db().execute(
    from(addresses)
      .where((q) => q("id").equals(address.id))
      .del(),
  )
  if (bytes) {
    await db().execute({
      text: "UPDATE domains SET bytes_used = GREATEST(0, bytes_used - $2) WHERE id = $1",
      values: [address.domain_id, bytes],
    })
  }
}

export const linkToAccount = async (addressId: string, userId: string): Promise<void> => {
  const address = await db().one<Address>(from(addresses).where((q) => q("id").equals(addressId)))
  if (!address) throw notFound("That address does not exist.")
  if (address.type === "alias" || address.type === "group") {
    throw invalidParameter("Forwarding addresses have no password to unify.")
  }

  await db().execute(
    from(addresses)
      .where((q) => q("id").equals(addressId))
      .update({
        user_id: userId,
        password_hash: null,
        password_changed_at: new Date(),
        updated_at: new Date(),
      }),
  )
}

/**
 * Gives a mailbox a password of its own again, so it can be handed to someone
 * who must not have the panel.
 *
 * A password is required rather than optional: unlinking without one would
 * leave a mailbox nothing can sign into, and the failure would show up later as
 * a client that has simply stopped working.
 */
export const unlinkFromAccount = async (addressId: string, password: string): Promise<void> => {
  const address = await db().one<Address>(from(addresses).where((q) => q("id").equals(addressId)))
  if (!address) throw notFound("That address does not exist.")
  if (!address.user_id) throw invalidParameter("That mailbox already has its own password.")

  await db().execute(
    from(addresses)
      .where((q) => q("id").equals(addressId))
      .update({
        user_id: null,
        password_hash: await hashPassword(password),
        password_changed_at: new Date(),
        updated_at: new Date(),
      }),
  )
}

// ----------------------------------------------------------------- route --

export type Route =
  | { kind: "mailbox"; address: Address; domain: Domain }
  | {
      kind: "forward"
      // Null for a role account, which forwards with no address row behind it.
      address: Address | null
      localPart: string
      domain: Domain
      destinations: string[]
    }
  | { kind: "unknown"; domain: Domain | null }

/**
 * Resolves one RCPT TO into what should actually happen to the message.
 *
 * Order matters and is the whole point:
 *   1. an exact address on the domain
 *   2. sub-addressing — user+tag@domain routes to user@domain
 *   3. the domain's catch-all
 *   4. the domain's fallback domain, followed once
 *   5. a role account, forwarded to whoever owns the domain
 *
 * Sub-addressing is checked before the catch-all so that a domain with both
 * still delivers `me+receipts@` to `me@` rather than sweeping it up.
 *
 * Role accounts come last, after every route the customer configured has been
 * tried, so this only ever turns a 550 into a delivery — it can never take mail
 * away from an address somebody set up on purpose.
 */
export const resolveRecipient = async (recipient: string, depth = 0): Promise<Route> => {
  const at = recipient.lastIndexOf("@")
  if (at <= 0) return { kind: "unknown", domain: null }

  const localPart = recipient.slice(0, at).toLowerCase()
  const domainName = recipient.slice(at + 1).toLowerCase()

  const domain = await db().one<Domain>(from(domains).where((q) => q("name").equals(domainName)))
  if (!domain) return { kind: "unknown", domain: null }

  const findLocal = (value: string) =>
    db().one<Address>(
      from(addresses).where((q) => [
        q("domain_id").equals(domain.id),
        q("local_part").equals(value),
      ]),
    )

  let address = await findLocal(localPart)

  if (!address && localPart.includes("+")) {
    const base = localPart.slice(0, localPart.indexOf("+"))
    if (base) address = await findLocal(base)
  }

  if (!address) {
    address = await db().one<Address>(
      from(addresses).where((q) => [
        q("domain_id").equals(domain.id),
        q("type").equals("catchall"),
      ]),
    )
  }

  if (!address) {
    // A fallback chain is followed exactly once. Two domains pointing at each
    // other is a configuration a customer can and will create.
    if (domain.fallback_domain_id && depth === 0) {
      const fallback = await db().one<Domain>(
        from(domains).where((q) => q("id").equals(domain.fallback_domain_id!)),
      )
      if (fallback) return resolveRecipient(`${localPart}@${fallback.name}`, depth + 1)
    }

    if (ROLE_ACCOUNTS.includes(localPart)) {
      const owner = await db().one<{ email: string }>(
        from(users)
          .select("email")
          .where((q) => q("id").equals(domain.user_id)),
      )
      // Forwarding an address to itself is a loop that survives every hop count
      // we control, and it is the exact shape this reaches when someone signs
      // up as postmaster@ on a domain they then host here.
      if (owner && owner.email.toLowerCase() !== `${localPart}@${domain.name}`) {
        return {
          kind: "forward",
          address: null,
          localPart,
          domain,
          destinations: [owner.email],
        }
      }
    }

    return { kind: "unknown", domain }
  }

  if (address.disabled) return { kind: "unknown", domain }

  if (address.type === "alias" || address.type === "group") {
    const destinations = (await destinationsOf(address.id)).map((d) => d.destination)
    return { kind: "forward", address, localPart: address.local_part, domain, destinations }
  }

  return { kind: "mailbox", address, domain }
}

/** Owner of the account a domain belongs to, for quota and logging. */
export const ownerOfDomain = async (domainId: string): Promise<string | null> => {
  const row = await db().one<{ user_id: string }>(
    from(domains)
      .select("user_id")
      .where((q) => q("id").equals(domainId)),
  )
  return row?.user_id ?? null
}
