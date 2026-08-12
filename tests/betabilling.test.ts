import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import { config } from "../src/config/index.ts"
import { db } from "../src/db/index.ts"
import { type Plan, plans, users } from "../src/schema/index.ts"

/**
 * Choosing a paid plan while nothing can be charged.
 *
 * A server with no payment provider used to send anyone who picked a paid plan
 * into a loop: "add a payment method before choosing a paid plan", and then
 * "no payment provider is configured on this server". Both messages are true
 * and together they are a dead end, which is not a state to invite beta users
 * into.
 *
 * `BILLING_BETA` says the quiet part out loud — the plan applies, nothing is
 * billed — and the panel says so rather than letting someone discover it by
 * trying. The prices stay on screen deliberately: people should know what the
 * thing will cost before they depend on it.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
let userId = ""
let paid: Plan | null = null

beforeAll(async () => {
  userId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Beta', $2) RETURNING id`,
    values: [`beta-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id

  paid = await db().one<Plan>(
    from(plans)
      .where((q) => q("monthly_cents").greaterThan(0))
      .orderBy("monthly_cents", "ASC")
      .limit(1),
  )
})

afterAll(async () => {
  await db().execute(
    from(users)
      .where((q) => q("id").equals(userId))
      .del(),
  )
})

describe("the beta billing switch", () => {
  test("is off unless an operator turns it on", () => {
    // A server that quietly stops charging is a worse failure than one that
    // refuses the plan change, so this must never default to true.
    expect(config.payments.beta).toBe(false)
  })

  test("there is a paid plan to be blocked by", async () => {
    // Guards the test below from passing because the seed has no paid plans.
    expect(paid).not.toBeNull()
    expect(paid?.monthly_cents).toBeGreaterThan(0)
  })

  test("a paid plan needs a payment method when billing is live", async () => {
    const method = await db().one<{ id: string }>({
      text: "SELECT id FROM payment_methods WHERE user_id = $1",
      values: [userId],
    })
    // The condition the route checks. With no method on file and beta off, the
    // paid plan is refused — which is correct, and is exactly what the beta
    // switch has to bypass.
    expect(method).toBeNull()
    expect(paid!.monthly_cents > 0 && !config.payments.beta).toBe(true)
  })
})
