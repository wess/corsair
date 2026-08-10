import { from } from "@atlas/db"
import { hashPassword } from "../auth/index.ts"
import { allColumns, db } from "../db/index.ts"
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
} from "../schema/index.ts"

export type AddressType = "standard" | "alias" | "catchall" | "group"

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
}

export const createAddress = async (
  input: CreateAddressInput,
): Promise<{ address: Address; destinations: AddressDestination[] }> => {
  const localPart = normalizeLocalPart(input.localPart)
  const needsPassword = input.type === "standard" || input.type === "catchall"
  const needsDestinations = input.type === "alias" || input.type === "group"

  if (needsPassword && !input.password) {
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
        password_hash: input.password ? await hashPassword(input.password) : null,
        filter_id: input.filterId ?? null,
        password_changed_at: input.password ? new Date() : null,
      })
      .returning(...allColumns(addresses)),
  ))!

  if (needsPassword) await provisionFolders(address.id)

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

export const setPassword = async (addressId: string, password: string): Promise<void> => {
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

// ----------------------------------------------------------------- route --

export type Route =
  | { kind: "mailbox"; address: Address; domain: Domain }
  | { kind: "forward"; address: Address; domain: Domain; destinations: string[] }
  | { kind: "unknown"; domain: Domain | null }

/**
 * Resolves one RCPT TO into what should actually happen to the message.
 *
 * Order matters and is the whole point:
 *   1. an exact address on the domain
 *   2. sub-addressing — user+tag@domain routes to user@domain
 *   3. the domain's catch-all
 *   4. the domain's fallback domain, followed once
 *
 * Sub-addressing is checked before the catch-all so that a domain with both
 * still delivers `me+receipts@` to `me@` rather than sweeping it up.
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
    return { kind: "unknown", domain }
  }

  if (address.disabled) return { kind: "unknown", domain }

  if (address.type === "alias" || address.type === "group") {
    const destinations = (await destinationsOf(address.id)).map((d) => d.destination)
    return { kind: "forward", address, domain, destinations }
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
