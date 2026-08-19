import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { createAddress, setPassword } from "../src/addresses/index.ts"
import { authenticateAddress, hashPassword } from "../src/auth/index.ts"
import { db } from "../src/db/index.ts"
import { consumeToken, issueToken } from "../src/notify/index.ts"
import { type Address, addresses, type Domain, domains, users } from "../src/schema/index.ts"

/**
 * Forgotten-mailbox-password recovery.
 *
 * The flow was fully built and switched off everywhere: no domain had
 * `self_service_enabled`, no mailbox had a `recovery_address`, and the "Forgot
 * your mailbox password?" link on the webmail sign-in therefore went nowhere it
 * could act on. These tests pin the eligibility rules so it stays honest —
 * both that it works when configured, and that it refuses when it is not.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `recover-${suffix}.invalid`

const ORIGINAL = "original-password-8891"
const REPLACEMENT = "replacement-password-2276"

let ownerId = ""
let domain: Domain
let mailbox: Address

/** The eligibility test `/api/recover/request` applies before sending anything. */
const eligible = (address: Address, d: Domain): boolean =>
  Boolean(
    d.self_service_enabled &&
      address.recovery_address &&
      !address.disabled &&
      (address.type === "standard" || address.type === "catchall"),
  )

const reload = async (id: string): Promise<Address> =>
  (await db().one<Address>(from(addresses).where((q) => q("id").equals(id))))!

beforeAll(async () => {
  ownerId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, $2, 'Recover', $3) RETURNING id`,
    values: [
      `owner@${zone}`,
      await hashPassword("account-password-5566"),
      Math.random().toString(36).slice(2, 12),
    ],
  }))!.id

  domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=recover', 'active') RETURNING *`,
    values: [ownerId, zone],
  }))!

  mailbox = (
    await createAddress({
      domainId: domain.id,
      localPart: "someone",
      type: "standard",
      password: ORIGINAL,
    })
  ).address
})

afterAll(async () => {
  await db().execute(
    from(users)
      .where((q) => q("id").equals(ownerId))
      .del(),
  )
})

describe("eligibility", () => {
  test("a domain with self service off sends nothing, however well configured the mailbox", async () => {
    await db().execute(
      from(addresses)
        .where((q) => q("id").equals(mailbox.id))
        .update({ recovery_address: `backup@${zone}-elsewhere.invalid` }),
    )
    expect(eligible(await reload(mailbox.id), domain)).toBe(false)
  })

  test("a mailbox with no recovery address is not eligible even when the domain allows it", async () => {
    await db().execute(
      from(domains)
        .where((q) => q("id").equals(domain.id))
        .update({ self_service_enabled: true }),
    )
    domain = (await db().one<Domain>(from(domains).where((q) => q("id").equals(domain.id))))!

    await db().execute(
      from(addresses)
        .where((q) => q("id").equals(mailbox.id))
        .update({ recovery_address: null }),
    )
    // This is the state every mailbox on the live server was in: the domain
    // switch is only half of it.
    expect(eligible(await reload(mailbox.id), domain)).toBe(false)
  })

  test("both halves configured makes it eligible", async () => {
    await db().execute(
      from(addresses)
        .where((q) => q("id").equals(mailbox.id))
        .update({ recovery_address: `backup@${zone}-elsewhere.invalid` }),
    )
    expect(eligible(await reload(mailbox.id), domain)).toBe(true)
  })

  test("a disabled mailbox is not eligible", async () => {
    await db().execute(
      from(addresses)
        .where((q) => q("id").equals(mailbox.id))
        .update({ disabled: true }),
    )
    expect(eligible(await reload(mailbox.id), domain)).toBe(false)

    await db().execute(
      from(addresses)
        .where((q) => q("id").equals(mailbox.id))
        .update({ disabled: false }),
    )
  })
})

describe("the token", () => {
  test("resets the password, once", async () => {
    const { token } = await issueToken({ kind: "address_recovery", addressId: mailbox.id })

    const first = await consumeToken("address_recovery", token)
    expect(first?.address_id).toBe(mailbox.id)

    await setPassword(mailbox.id, REPLACEMENT)
    expect(await authenticateAddress(`someone@${zone}`, REPLACEMENT)).not.toBeNull()
    expect(await authenticateAddress(`someone@${zone}`, ORIGINAL)).toBeNull()

    // A link that worked twice is a link that works for whoever reads the
    // mailbox it was sent to, forever.
    expect(await consumeToken("address_recovery", token)).toBeNull()
  })

  test("an expired token is refused", async () => {
    const { token, row } = await issueToken({ kind: "address_recovery", addressId: mailbox.id })
    await db().execute({
      text: `UPDATE tokens SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      values: [row.id],
    })
    expect(await consumeToken("address_recovery", token)).toBeNull()
  })

  test("a token of another kind does not redeem here", async () => {
    // The kind is part of the lookup, so a verification link cannot be spent as
    // a password reset.
    const { token } = await issueToken({ kind: "email_verification", userId: ownerId })
    expect(await consumeToken("address_recovery", token)).toBeNull()
  })
})
