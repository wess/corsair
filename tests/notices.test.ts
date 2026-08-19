import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { createAddress } from "../src/addresses/index.ts"
import { hashPassword } from "../src/auth/index.ts"
import { db } from "../src/db/index.ts"
import { accountNotices, mailboxNotices } from "../src/notices/index.ts"
import { type Address, addresses, type Domain, domains, users } from "../src/schema/index.ts"

/**
 * Notices.
 *
 * The property worth holding down is not that they appear — it is that they
 * **stop** appearing once the thing they describe is fixed, and that they are
 * never raised at somebody who cannot fix it. A banner that outlives its cause,
 * or that asks for something impossible, is one people learn to ignore, and
 * then the useful ones go unread too.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `notice-${suffix}.invalid`

let ownerId = ""
let domain: Domain
let mailbox: Address

const reloadDomain = async (): Promise<Domain> =>
  (await db().one<Domain>(from(domains).where((q) => q("id").equals(domain.id))))!

const reloadMailbox = async (): Promise<Address> =>
  (await db().one<Address>(from(addresses).where((q) => q("id").equals(mailbox.id))))!

const ids = (list: { id: string }[]) => list.map((n) => n.id)

beforeAll(async () => {
  ownerId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code, email_verified_at)
           VALUES ($1, $2, 'Notice', $3, now()) RETURNING id`,
    values: [
      `owner@${zone}`,
      await hashPassword("account-password-3311"),
      Math.random().toString(36).slice(2, 12),
    ],
  }))!.id

  domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=notice', 'pending') RETURNING *`,
    values: [ownerId, zone],
  }))!
})

afterAll(async () => {
  await db().execute(
    from(users)
      .where((q) => q("id").equals(ownerId))
      .del(),
  )
})

describe("an account's notices", () => {
  test("an unverified domain is raised, and nothing else about it", async () => {
    const notices = await accountNotices(ownerId)
    expect(ids(notices)).toContain(`domain_unverified:${domain.id}`)
    // "It has no mailboxes" is true and useless while it is not even verified;
    // two rows for one unfinished job reads as two jobs.
    expect(ids(notices)).not.toContain(`domain_empty:${domain.id}`)
  })

  test("once verified, the empty domain is what needs attention", async () => {
    await db().execute(
      from(domains)
        .where((q) => q("id").equals(domain.id))
        .update({ status: "active" }),
    )
    domain = await reloadDomain()

    const notices = await accountNotices(ownerId)
    expect(ids(notices)).not.toContain(`domain_unverified:${domain.id}`)
    expect(ids(notices)).toContain(`domain_empty:${domain.id}`)
  })

  test("adding a mailbox clears it", async () => {
    mailbox = (
      await createAddress({
        domainId: domain.id,
        localPart: "someone",
        type: "standard",
        password: "mailbox-password-9922",
      })
    ).address

    expect(ids(await accountNotices(ownerId))).not.toContain(`domain_empty:${domain.id}`)
  })

  test("recovery enabled with nowhere to send a link is raised to the person who enabled it", async () => {
    await db().execute(
      from(domains)
        .where((q) => q("id").equals(domain.id))
        .update({ self_service_enabled: true }),
    )
    domain = await reloadDomain()

    expect(ids(await accountNotices(ownerId))).toContain(`recovery_gap:${domain.id}`)
  })

  test("and clears when the mailbox has one", async () => {
    await db().execute(
      from(addresses)
        .where((q) => q("id").equals(mailbox.id))
        .update({ recovery_address: `elsewhere@${zone}-other.invalid` }),
    )
    expect(ids(await accountNotices(ownerId))).not.toContain(`recovery_gap:${domain.id}`)
  })

  test("an unverified account email is raised", async () => {
    await db().execute(
      from(users)
        .where((q) => q("id").equals(ownerId))
        .update({ email_verified_at: null }),
    )
    expect(ids(await accountNotices(ownerId))).toContain("email_unverified")

    await db().execute(
      from(users)
        .where((q) => q("id").equals(ownerId))
        .update({ email_verified_at: new Date() }),
    )
    expect(ids(await accountNotices(ownerId))).not.toContain("email_unverified")
  })
})

describe("a mailbox's notices", () => {
  test("nothing is raised when recovery is off for the domain", async () => {
    // The mailbox holder cannot turn it on, so telling them to set an address
    // would be asking for something that changes nothing.
    const off = { ...(await reloadDomain()), self_service_enabled: false }
    const address = { ...(await reloadMailbox()), recovery_address: null }
    expect(mailboxNotices(address, off)).toEqual([])
  })

  test("a missing recovery address is raised once the domain allows it", async () => {
    const on = await reloadDomain()
    const address = { ...(await reloadMailbox()), recovery_address: null }
    const notices = mailboxNotices(address, on)
    expect(ids(notices)).toEqual(["recovery_missing"])
    // It has to lead somewhere, or it is just bad news.
    expect(notices[0]?.action?.target).toBe("settings")
  })

  test("setting one clears it", async () => {
    expect(mailboxNotices(await reloadMailbox(), await reloadDomain())).toEqual([])
  })

  test("a mailbox that signs in with an account password is not asked", async () => {
    // Its credential is the account's, and so is its recovery.
    const linked = { ...(await reloadMailbox()), recovery_address: null, user_id: ownerId }
    expect(mailboxNotices(linked, await reloadDomain())).toEqual([])
  })
})
