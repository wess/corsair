import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import {
  createAddress,
  linkToAccount,
  setPassword,
  unlinkFromAccount,
} from "../src/addresses/index.ts"
import {
  authenticateAddress,
  hashPassword,
  issueMailSession,
  MAIL_COOKIE,
  resolveMailSession,
  verifyMailboxPassword,
} from "../src/auth/index.ts"
import { db } from "../src/db/index.ts"
import { type Address, type Domain, users } from "../src/schema/index.ts"

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

describe("re-authenticating a mailbox without signing it in", () => {
  /**
   * `verifyMailboxPassword` backs the webmail's change-password form, which has
   * to confirm the current password before writing a new one. It shares
   * `mailboxHash` with the login path on purpose: a check that disagreed with
   * what `authenticateAddress` accepts would either refuse a correct password
   * or, worse, accept one the login would not.
   */
  test("accepts exactly what the login path accepts, for a mailbox with its own password", async () => {
    const address = (await db().one<Address>({
      text: `SELECT * FROM addresses WHERE domain_id = $1 AND local_part = 'family'`,
      values: [domain.id],
    }))!

    expect(await verifyMailboxPassword(address, MAILBOX_PASSWORD)).toBe(true)
    expect(await verifyMailboxPassword(address, ACCOUNT_PASSWORD)).toBe(false)
    expect(await verifyMailboxPassword(address, "not-the-password")).toBe(false)
  })

  test("checks the account's password for a mailbox that is its owner's account", async () => {
    const address = (await db().one<Address>({
      text: `SELECT * FROM addresses WHERE domain_id = $1 AND local_part = 'owner'`,
      values: [domain.id],
    }))!

    // The address carries no hash of its own; the credential is the owner's.
    expect(address.password_hash).toBeNull()
    expect(await verifyMailboxPassword(address, ACCOUNT_PASSWORD)).toBe(true)
    expect(await verifyMailboxPassword(address, MAILBOX_PASSWORD)).toBe(false)
  })

  test("does not record a login", async () => {
    // Opening the settings panel and changing your mind must not look like a
    // sign-in on the mailbox.
    const before = (await db().one<Address>({
      text: `SELECT * FROM addresses WHERE domain_id = $1 AND local_part = 'family'`,
      values: [domain.id],
    }))!

    await verifyMailboxPassword(before, MAILBOX_PASSWORD)

    const after = (await db().one<Address>({
      text: `SELECT * FROM addresses WHERE domain_id = $1 AND local_part = 'family'`,
      values: [domain.id],
    }))!
    expect(after.last_login_at).toEqual(before.last_login_at)
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

describe("linking a mailbox explicitly", () => {
  /**
   * The automatic match only fires when the panel sign-in address and the
   * mailbox address are identical. Most people sign in as one address and read
   * another, so without an explicit link they would still hold two passwords —
   * which was the whole complaint.
   */
  test("an owner can adopt a mailbox that is not their sign-in address", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "adopted",
      type: "standard",
      password: MAILBOX_PASSWORD,
    })
    expect(address.user_id).toBeNull()

    await linkToAccount(address.id, ownerId)

    expect(await authenticateAddress(`adopted@${zone}`, ACCOUNT_PASSWORD)).not.toBeNull()
    // The mailbox's own password is cleared, not kept as a fallback. Two
    // working passwords where the panel shows one means revoking the account
    // password would not revoke mail access.
    expect(await authenticateAddress(`adopted@${zone}`, MAILBOX_PASSWORD)).toBeNull()
  })

  test("one account can back several of its own mailboxes", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "second",
      type: "standard",
      password: MAILBOX_PASSWORD,
    })
    await linkToAccount(address.id, ownerId)

    // Both open with the one password. The unique index that forbade this was
    // removed precisely for this case.
    expect(await authenticateAddress(`adopted@${zone}`, ACCOUNT_PASSWORD)).not.toBeNull()
    expect(await authenticateAddress(`second@${zone}`, ACCOUNT_PASSWORD)).not.toBeNull()
  })

  test("a mailbox can be separated again for someone else to read", async () => {
    const address = await db().one<{ id: string }>({
      text: "SELECT id FROM addresses WHERE domain_id = $1 AND local_part = 'second'",
      values: [domain.id],
    })
    const handover = "handed-over-password-8890"
    await unlinkFromAccount(address!.id, handover)

    expect(await authenticateAddress(`second@${zone}`, handover)).not.toBeNull()
    expect(await authenticateAddress(`second@${zone}`, ACCOUNT_PASSWORD)).toBeNull()
  })

  test("a forwarding address has no password to unify", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "fwd",
      type: "alias",
      destinations: ["elsewhere@example.com"],
    })
    await expect(linkToAccount(address.id, ownerId)).rejects.toThrow(/no password/i)
  })

  test("created directly with the account password, no mailbox password needed", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "direct",
      type: "standard",
      useAccountPassword: true,
      ownerId,
    })

    expect(address.user_id).toBe(ownerId)
    expect(address.password_hash).toBeNull()
    expect(await authenticateAddress(`direct@${zone}`, ACCOUNT_PASSWORD)).not.toBeNull()
  })
})

describe("the session a mailbox sign-in produces", () => {
  /**
   * The linked mailbox has no `password_hash` of its own, and the webmail
   * session check treated a missing hash as "not a real mailbox". So sign-in
   * succeeded, the cookie was issued, and the very next request answered
   * "Sign in to your mailbox first" — a login that appears to work and then
   * does not. Reported from the browser, not caught by any test.
   */
  test("a linked mailbox resolves its own session", async () => {
    const identity = await authenticateAddress(`owner@${zone}`, ACCOUNT_PASSWORD)
    expect(identity).not.toBeNull()

    const cookie = `${MAIL_COOKIE}=${await issueMailSession(identity!.address.id)}`
    const resolved = await resolveMailSession(cookie)

    expect(resolved).not.toBeNull()
    expect(resolved?.email).toBe(`owner@${zone}`)
  })

  test("the session dies with the account it belongs to", async () => {
    const identity = await authenticateAddress(`owner@${zone}`, ACCOUNT_PASSWORD)
    const cookie = `${MAIL_COOKIE}=${await issueMailSession(identity!.address.id)}`

    await db().execute(
      from(users)
        .where((q) => q("id").equals(ownerId))
        .update({ status: "terminated" }),
    )
    expect(await resolveMailSession(cookie)).toBeNull()

    await db().execute(
      from(users)
        .where((q) => q("id").equals(ownerId))
        .update({ status: "active" }),
    )
  })
})

describe("signing in with the control-panel address", () => {
  /**
   * Someone who signs up as `me@wess.io` and reads `wess@wess.dev` knows one
   * address and one password. Requiring a second address in the mail client is
   * the same confusion the shared password removed, moved one field left.
   */
  test("the account email opens the mailbox linked to it", async () => {
    const identity = await authenticateAddress(`owner@${zone}`, ACCOUNT_PASSWORD)
    expect(identity).not.toBeNull()
    // Resolves to the mailbox, not to the address that was typed.
    expect(identity?.email).toBe(`owner@${zone}`)
  })

  test("it refuses a wrong password just as flatly", async () => {
    expect(await authenticateAddress(`owner@${zone}`, "not-the-password")).toBeNull()
  })

  test("an account with no linked mailbox opens nothing", async () => {
    // `ceo@<zone>` is a registered account whose same-named mailbox is
    // deliberately unlinked, because it does not own the domain.
    expect(await authenticateAddress(`ceo@${zone}`, "squatter-password-5150")).toBeNull()
  })
})
