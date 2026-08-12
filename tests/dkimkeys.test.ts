import { createPublicKey } from "node:crypto"
import { afterAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { config } from "../src/config/index.ts"
import { db } from "../src/db/index.ts"
import { createDomain } from "../src/domains/index.ts"
import { dkimRecord } from "../src/dkim/index.ts"
import { type DkimKey, dkimKeys, users } from "../src/schema/index.ts"

/**
 * Every domain on this installation signs with the same key per selector host.
 *
 * A customer publishes `corsair-1._domainkey.<their domain>` as a CNAME to
 * `MAIL_DKIM_HOSTS[0]` — a single name in this server's zone holding a single
 * TXT record. A per-domain keypair cannot be expressed in that: the second
 * domain's public key has nowhere to go, so its signatures fail at every
 * receiver while looking perfectly well-formed on the way out.
 *
 * That is not hypothetical. This server ran with three selectors whose private
 * keys matched no published record, and the only symptom was `dkim=fail` in
 * other people's headers.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const made: string[] = []

const makeUser = async () =>
  (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Dkim', $2) RETURNING id`,
    values: [`dkim-${suffix}-${made.length}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id

afterAll(async () => {
  for (const id of made) {
    await db().execute(
      from(users)
        .where((q) => q("id").equals(id))
        .del(),
    )
  }
})

const keysOf = async (domainId: string) =>
  await db().all<DkimKey>(
    from(dkimKeys)
      .where((q) => q("domain_id").equals(domainId))
      .orderBy("position", "ASC"),
  )

describe("dkim keys across domains", () => {
  test("a second domain adopts the first one's keys, host for host", async () => {
    const ownerA = await makeUser()
    made.push(ownerA)
    const a = await createDomain({ userId: ownerA, name: `first-${suffix}.invalid` })

    const ownerB = await makeUser()
    made.push(ownerB)
    const b = await createDomain({ userId: ownerB, name: `second-${suffix}.invalid` })

    const first = await keysOf(a.domain.id)
    const second = await keysOf(b.domain.id)

    expect(first.length).toBe(config.mail.dkimHosts.length)
    expect(second.length).toBe(first.length)

    for (const [i, key] of first.entries()) {
      // Same host, therefore same published TXT, therefore the same key.
      expect(second[i]?.cname_target).toBe(key.cname_target)
      expect(second[i]?.public_key).toBe(key.public_key)
      expect(second[i]?.private_key).toBe(key.private_key)
    }
  })

  test("each host still gets a key of its own", async () => {
    const owner = await makeUser()
    made.push(owner)
    const { domain } = await createDomain({ userId: owner, name: `third-${suffix}.invalid` })
    const keys = await keysOf(domain.id)

    // Sharing across domains must not collapse into sharing across selectors:
    // a rotation is "flip active to the next position", which achieves nothing
    // if the next position holds the same key.
    const distinct = new Set(keys.map((k) => k.public_key))
    expect(distinct.size).toBe(keys.length)
    expect(keys[0]?.active).toBe(true)
  })

  test("the stored public key is the one the private key derives", async () => {
    // The check that would have caught the outage: a published record is only
    // useful if it is the counterpart of the key doing the signing.
    const owner = await makeUser()
    made.push(owner)
    const { domain } = await createDomain({ userId: owner, name: `fourth-${suffix}.invalid` })

    for (const key of await keysOf(domain.id)) {
      const derived = createPublicKey(key.private_key).export({
        type: "spki",
        format: "pem",
      }) as string
      expect(dkimRecord(derived)).toBe(dkimRecord(key.public_key))
    }
  })
})
