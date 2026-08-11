import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { createAddress, setPassword } from "../src/addresses/index.ts"
import { authenticateAddress, hashPassword } from "../src/auth/index.ts"
import { db } from "../src/db/index.ts"
import { type Domain, users } from "../src/schema/index.ts"

/**
 * One password for the panel and the mailbox, where they are the same person.
 *
 * The rule that matters is not the convenience — it is the condition on the
 * link. A mailbox is only bound to a control-panel account when that account
 * **already owns the domain**. Without that, anyone could register a panel
 * account as `ceo@some-company.com` before that company added its domain, and
 * the mailbox would silently authenticate against the squatter's password the
 * moment it was created. There is a test for exactly that below; it is the
 * reason the condition exists and it must not be relaxed.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `creds-${suffix}.invalid`

const ACCOUNT_PASSWORD = "account-password-9182"
const MAILBOX_PASSWORD = "mailbox-password-7261"

let ownerId = ""
let squatterId = ""
let domain: Domain

const makeUser = async (email: string, password: string | null) =>
  (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, $2, 'Creds', $3) RETURNING id`,
    values: [
      email,
      password ? await hashPassword(password) : null,
      Math.random().toString(36).slice(2, 12),
    ],
  }))!.id

beforeAll(async () => {
  ownerId = await makeUser(`owner@${zone}`, ACCOUNT_PASSWORD)
  // Registered with an address on a domain they do not own.
  squatterId = await makeUser(`ceo@${zone}`, "squatter-password-5150")

  domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=creds', 'active') RETURNING *`,
    values: [ownerId, zone],
  }))!
})

afterAll(async () => {
  await db().execute(
    from(users)
      .where((q) => q("id").equals(ownerId))
      .del(),
  )
  await db().execute(
    from(users)
      .where((q) => q("id").equals(squatterId))
      .del(),
  )
})

describe("a mailbox that is its owner's own account", () => {
  test("is created without a password of its own", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "owner",
      type: "standard",
    })

    expect(address.user_id).toBe(ownerId)
    // Two hashes for one person is how they drift apart.
    expect(address.password_hash).toBeNull()
  })

  test("authenticates with the account password", async () => {
    const identity = await authenticateAddress(`owner@${zone}`, ACCOUNT_PASSWORD)
    expect(identity).not.toBeNull()
    expect(identity?.email).toBe(`owner@${zone}`)
  })

  test("refuses any other password", async () => {
    expect(await authenticateAddress(`owner@${zone}`, MAILBOX_PASSWORD)).toBeNull()
    expect(await authenticateAddress(`owner@${zone}`, "")).toBeNull()
  })

  test("follows a change to the account password", async () => {
    const changed = "account-password-rotated-3344"
    await db().execute(
      from(users)
        .where((q) => q("id").equals(ownerId))
        .update({ password_hash: await hashPassword(changed) }),
    )

    expect(await authenticateAddress(`owner@${zone}`, changed)).not.toBeNull()
    expect(await authenticateAddress(`owner@${zone}`, ACCOUNT_PASSWORD)).toBeNull()

    await db().execute(
      from(users)
        .where((q) => q("id").equals(ownerId))
        .update({ password_hash: await hashPassword(ACCOUNT_PASSWORD) }),
    )
  })

  test("refuses a second password being set on it", async () => {
    const address = await db().one<{ id: string }>({
      text: "SELECT id FROM addresses WHERE domain_id = $1 AND local_part = 'owner'",
      values: [domain.id],
    })

    // Writing a hash here would silently re-split the credential: the account
    // password would keep working and the new one would not.
    await expect(setPassword(address!.id, "some-other-password")).rejects.toThrow(
      /account password/i,
    )
  })

  test("stops authenticating when the account is terminated", async () => {
    await db().execute(
      from(users)
        .where((q) => q("id").equals(ownerId))
        .update({ status: "terminated" }),
    )
    expect(await authenticateAddress(`owner@${zone}`, ACCOUNT_PASSWORD)).toBeNull()

    await db().execute(
      from(users)
        .where((q) => q("id").equals(ownerId))
        .update({ status: "active" }),
    )
    expect(await authenticateAddress(`owner@${zone}`, ACCOUNT_PASSWORD)).not.toBeNull()
  })
})

describe("a mailbox that is not an account", () => {
  test("keeps its own password", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "family",
      type: "standard",
      password: MAILBOX_PASSWORD,
    })

    expect(address.user_id).toBeNull()
    expect(address.password_hash).not.toBeNull()
    expect(await authenticateAddress(`family@${zone}`, MAILBOX_PASSWORD)).not.toBeNull()
  })

  test("does not accept the domain owner's account password", async () => {
    // The other people on a family or team domain hold a mailbox credential and
    // nothing else. Merging them into the owner's account would hand them the
    // panel.
    expect(await authenticateAddress(`family@${zone}`, ACCOUNT_PASSWORD)).toBeNull()
  })

  test("still requires a password at creation", async () => {
    await expect(
      createAddress({ domainId: domain.id, localPart: "nopassword", type: "standard" }),
    ).rejects.toThrow(/needs a password/i)
  })
})

describe("the domain-ownership condition", () => {
  test("an account that does not own the domain is never linked", async () => {
    // `ceo@<zone>` is a registered panel account, but the domain belongs to
    // someone else. Linking here would let the squatter read the mail.
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "ceo",
      type: "standard",
      password: MAILBOX_PASSWORD,
    })

    expect(address.user_id).toBeNull()
    expect(await authenticateAddress(`ceo@${zone}`, "squatter-password-5150")).toBeNull()
    expect(await authenticateAddress(`ceo@${zone}`, MAILBOX_PASSWORD)).not.toBeNull()
  })
})
