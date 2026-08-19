import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import {
  administeredDomain,
  administeredDomainIds,
  grantFor,
  isSystemAdmin,
  ownedDomain,
} from "../src/access/index.ts"
import { createAddress } from "../src/addresses/index.ts"
import { hashPassword } from "../src/auth/index.ts"
import { db } from "../src/db/index.ts"
import { type Domain, domainAdmins, users } from "../src/schema/index.ts"

/**
 * Who may act on a domain.
 *
 * The rule this file exists to hold down is the *negative* one: a domain
 * administrator was delegated mailboxes and nothing else. Every test that
 * asserts a delegate is refused something is load-bearing — widening any of
 * them hands somebody else's domain, DNS, or billing to a delegate, and the
 * failure would not be visible until it had already happened.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `access-${suffix}.invalid`

let ownerId = ""
let sysAdminId = ""
let delegateId = ""
let strangerId = ""
let domain: Domain

const makeUser = async (email: string, extra: { isAdmin?: boolean } = {}) =>
  (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code, is_admin)
           VALUES ($1, $2, 'Access', $3, $4) RETURNING id`,
    values: [
      email,
      await hashPassword("access-password-1234"),
      Math.random().toString(36).slice(2, 12),
      extra.isAdmin ?? false,
    ],
  }))!.id

beforeAll(async () => {
  ownerId = await makeUser(`owner@${zone}`)
  sysAdminId = await makeUser(`sysadmin@${zone}`, { isAdmin: true })
  delegateId = await makeUser(`delegate@${zone}`)
  strangerId = await makeUser(`stranger@${zone}`)

  domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=access', 'active') RETURNING *`,
    values: [ownerId, zone],
  }))!

  await db().execute(
    from(domainAdmins).insert({ domain_id: domain.id, user_id: delegateId, granted_by: ownerId }),
  )
})

afterAll(async () => {
  for (const id of [ownerId, sysAdminId, delegateId, strangerId]) {
    await db().execute(
      from(users)
        .where((q) => q("id").equals(id))
        .del(),
    )
  }
})

describe("system administration", () => {
  test("is carried by is_admin, separately from ownership", async () => {
    expect(await isSystemAdmin(sysAdminId)).toBe(true)
    expect(await isSystemAdmin(ownerId)).toBe(false)
    expect(await isSystemAdmin(delegateId)).toBe(false)
  })

  test("is lost when the account stops being active", async () => {
    // The flag stays in the row; the authority it describes does not survive
    // suspension. Reading the flag alone would keep a suspended administrator
    // acting on every domain on the box.
    await db().execute(
      from(users)
        .where((q) => q("id").equals(sysAdminId))
        .update({ status: "suspended" }),
    )
    expect(await isSystemAdmin(sysAdminId)).toBe(false)

    await db().execute(
      from(users)
        .where((q) => q("id").equals(sysAdminId))
        .update({ status: "active" }),
    )
    expect(await isSystemAdmin(sysAdminId)).toBe(true)
  })

  test("reaches every domain, owned or not", async () => {
    expect((await administeredDomain(sysAdminId, domain.id)).id).toBe(domain.id)
    expect((await ownedDomain(sysAdminId, domain.id)).id).toBe(domain.id)
    expect(await administeredDomainIds(sysAdminId)).toBe("all")
  })
})

describe("a domain administrator", () => {
  test("may administer the domain they are named on", async () => {
    expect((await administeredDomain(delegateId, domain.id)).id).toBe(domain.id)
    expect(await administeredDomainIds(delegateId)).toEqual([domain.id])
  })

  test("does not own it", async () => {
    const grant = await grantFor(delegateId, domain)
    expect(grant.administers).toBe(true)
    expect(grant.owns).toBe(false)
    expect(grant.system).toBe(false)
  })

  /**
   * The line the whole design rests on. `ownedDomain` gates deleting the
   * domain, its DNS, its settings, and appointing other administrators — a
   * delegate reaching it could hand the domain's mail to a stranger.
   */
  test("is refused everything gated on ownership", async () => {
    await expect(ownedDomain(delegateId, domain.id)).rejects.toThrow(/not found/i)
  })

  test("loses the grant the moment the row goes", async () => {
    await db().execute(
      from(domainAdmins)
        .where((q) => [q("domain_id").equals(domain.id), q("user_id").equals(delegateId)])
        .del(),
    )
    await expect(administeredDomain(delegateId, domain.id)).rejects.toThrow(/not found/i)

    await db().execute(
      from(domainAdmins).insert({ domain_id: domain.id, user_id: delegateId, granted_by: ownerId }),
    )
    expect((await administeredDomain(delegateId, domain.id)).id).toBe(domain.id)
  })
})

describe("an unrelated account", () => {
  test("cannot see the domain at all", async () => {
    await expect(administeredDomain(strangerId, domain.id)).rejects.toThrow(/not found/i)
    await expect(ownedDomain(strangerId, domain.id)).rejects.toThrow(/not found/i)
    expect(await administeredDomainIds(strangerId)).toEqual([])
  })

  test("is refused with the same answer as a domain that does not exist", async () => {
    // A caller who may not touch a domain must not be able to learn it exists
    // from the shape of the refusal.
    const missing = "00000000-0000-0000-0000-000000000000"
    const forbidden = await administeredDomain(strangerId, domain.id).catch((e) => e.message)
    const absent = await administeredDomain(strangerId, missing).catch((e) => e.message)
    expect(forbidden).toBe(absent)
  })
})

describe("mailbox creation by a delegate", () => {
  test("a delegate's mailbox gets its own password, never a linked one", async () => {
    // `createAddress` takes `ownerId` on trust — the route is what refuses the
    // linked form for a delegate. This asserts the underlying behaviour the
    // route's guard exists to prevent: passing a non-owner through would bind
    // the mailbox to them.
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "delegated",
      type: "standard",
      password: "mailbox-password-4321",
    })
    expect(address.user_id).toBeNull()
    expect(address.password_hash).not.toBeNull()
  })
})
