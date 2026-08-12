import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { owner } from "../src/api/pipes/index.ts"
import { db } from "../src/db/index.ts"
import { users } from "../src/schema/index.ts"

/**
 * The gate in front of the server's own journal.
 *
 * Those lines carry every account's addresses, IP addresses, and delivery
 * outcomes, so this is the one part of the panel where the question is not
 * "which customer is this" but "is this the person who runs the machine".
 *
 * The check reads `is_owner` from the database on every request rather than
 * trusting anything in the session, because a session issued before ownership
 * changed would otherwise keep its access. Hiding the nav entry is courtesy;
 * this is the control.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const made: string[] = []

const makeUser = async (isOwner: boolean) => {
  const row = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code, is_owner)
           VALUES ($1, 'x', 'Gate', $2, $3) RETURNING id`,
    values: [
      `gate-${suffix}-${made.length}@corsair.test`,
      Math.random().toString(36).slice(2, 12),
      isOwner,
    ],
  })
  made.push(row!.id)
  return row!.id
}

/** The shape the pipe reads: assigns carrying an authenticated principal. */
const connFor = (userId: string) => ({ assigns: { principal: { userId } } })

let ordinaryId = ""

beforeAll(async () => {
  ordinaryId = await makeUser(false)
})

afterAll(async () => {
  for (const id of made) {
    await db().execute(
      from(users)
        .where((q) => q("id").equals(id))
        .del(),
    )
  }
})

describe("who may read the server's logs", () => {
  test("an ordinary account is refused", async () => {
    await expect(owner(connFor(ordinaryId) as never)).rejects.toThrow(/owner of this server/i)
  })

  test("the refusal is a 403, not a 404 or a 500", async () => {
    try {
      await owner(connFor(ordinaryId) as never)
      throw new Error("the pipe let a non-owner through")
    } catch (e) {
      expect((e as { status?: number }).status).toBe(403)
    }
  })

  test("an account that does not exist is refused", async () => {
    // A session whose user was deleted must not fall through to allowed.
    await expect(owner(connFor("00000000-0000-0000-0000-000000000000") as never)).rejects.toThrow(
      /owner of this server/i,
    )
  })

  test("the owner is allowed through", async () => {
    const existing = await db().one<{ id: string }>({
      text: "SELECT id FROM users WHERE is_owner LIMIT 1",
      values: [],
    })
    // The partial unique index allows exactly one owner, so use the real one if
    // this database already has it and mint one only when it does not.
    const ownerId = existing?.id ?? (await makeUser(true))
    await expect(owner(connFor(ownerId) as never)).resolves.toBeDefined()
  })

  test("ownership is re-read, not remembered", async () => {
    // Clearing the flag must take effect on the next request. A check cached in
    // the session would keep a demoted account's access alive.
    //
    // Toggling the real owner rather than minting a second one: the partial
    // unique index `users_single_owner_idx` permits exactly one, and an earlier
    // version of this test was refused by it — correctly.
    const existing = await db().one<{ id: string }>({
      text: "SELECT id FROM users WHERE is_owner LIMIT 1",
      values: [],
    })
    if (!existing) return

    const setOwner = (value: boolean) =>
      db().execute(
        from(users)
          .where((q) => q("id").equals(existing.id))
          .update({ is_owner: value }),
      )

    try {
      await expect(owner(connFor(existing.id) as never)).resolves.toBeDefined()
      await setOwner(false)
      await expect(owner(connFor(existing.id) as never)).rejects.toThrow(/owner of this server/i)
    } finally {
      // Restored even if an assertion above threw, or this database is left
      // with no owner at all.
      await setOwner(true)
    }
  })
})
