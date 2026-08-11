import { afterAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { db } from "../src/db/index.ts"
import { users } from "../src/schema/index.ts"

/**
 * The first account created owns the instance.
 *
 * The claim is made *inside* the INSERT — `NOT EXISTS (SELECT 1 FROM users)` —
 * and backed by a partial unique index, so two simultaneous signups cannot both
 * win. Checking "are there any users yet?" in a separate read and then inserting
 * is the version of this that has a race, and the race hands a stranger the
 * instance.
 *
 * The signup route catches `23505` on **that constraint specifically** and
 * retries as a non-owner. Widening the catch would swallow the duplicate-email
 * violation, which is a different error that must reach the caller as a 409.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const made: string[] = []

const insert = async (email: string, claimOwnership: boolean) => {
  const row = await db().one<{ id: string; is_owner: boolean }>({
    text: `INSERT INTO users (email, password_hash, referral_code, is_owner)
           VALUES ($1, 'x', $2, ${claimOwnership ? "NOT EXISTS (SELECT 1 FROM users)" : "false"})
           RETURNING id, is_owner`,
    values: [email, Math.random().toString(36).slice(2, 12)],
  })
  if (row) made.push(row.id)
  return row
}

afterAll(async () => {
  for (const id of made) {
    await db().execute(
      from(users)
        .where((q) => q("id").equals(id))
        .del(),
    )
  }
})

describe("instance ownership", () => {
  test("the claim is evaluated inside the INSERT", async () => {
    // This suite runs against a database that already has rows, which is the
    // condition being tested: a later signup must not claim ownership.
    const existing = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM users",
      values: [],
    })
    expect(Number(existing?.count ?? 0)).toBeGreaterThan(0)

    const later = await insert(`later-${suffix}@corsair.test`, true)
    expect(later?.is_owner).toBe(false)
  })

  test("a second owner is refused by the index, not by a read", async () => {
    const owner = await db().one<{ id: string }>({
      text: "SELECT id FROM users WHERE is_owner LIMIT 1",
      values: [],
    })

    // Either there is already an owner and a second insert must fail, or there
    // is none and one insert must succeed and the next must fail. Both paths
    // end with "exactly one owner is possible".
    if (!owner) {
      const first = await insert(`owner-${suffix}@corsair.test`, true)
      expect(first?.is_owner).toBe(true)
    }

    let code: string | undefined
    try {
      await db().one<{ id: string }>({
        text: `INSERT INTO users (email, password_hash, referral_code, is_owner)
               VALUES ($1, 'x', $2, true) RETURNING id`,
        values: [`second-owner-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
      })
    } catch (e) {
      const err = e as { errno?: string; code?: string; constraint?: string }
      code = err.errno ?? err.code
      // The signup route keys its retry off this exact constraint name.
      expect(err.constraint).toBe("users_single_owner_idx")
    }
    expect(code).toBe("23505")
  })

  test("a duplicate email is a different violation from a duplicate owner", async () => {
    const email = `dupe-${suffix}@corsair.test`
    await insert(email, false)

    let constraint: string | undefined
    try {
      await insert(email, false)
    } catch (e) {
      constraint = (e as { constraint?: string }).constraint
    }

    // Both are 23505. Only the constraint name separates "retry as a
    // non-owner" from "tell the caller the address is taken", which is why the
    // signup route must not widen its catch to the SQLSTATE alone.
    expect(constraint).toBeDefined()
    expect(constraint).not.toBe("users_single_owner_idx")
  })
})
