import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { buildFetch } from "../src/api/index.ts"
import { issueSession, SESSION_COOKIE } from "../src/auth/index.ts"
import { db } from "../src/db/index.ts"
import { isConfigured } from "../src/payments/index.ts"
import type { Plan } from "../src/schema/index.ts"

/**
 * What a customer may do to their own billing, with and without a payment provider.
 *
 * With one, a paid plan is bought at the provider and switched on by its signed
 * webhook, and a payment method is whatever that webhook says. The routes used to
 * accept both from the client — a made-up "payment method" row unlocked every paid
 * plan, and a `paid` transaction was written without anything being charged.
 *
 * The first block only runs when a provider is configured, which is a process-wide
 * setting: `bun run test` runs this file a second time with a Stripe key set.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const app = buildFetch(null)
let userId = ""
let cookie = ""
let paid: Plan
let free: Plan

const call = (path: string, init: RequestInit = {}) =>
  app(
    new Request(`http://corsair.test${path}`, {
      ...init,
      headers: { "content-type": "application/json", cookie, ...init.headers },
    }),
  )

beforeAll(async () => {
  userId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Bill', $2) RETURNING id`,
    values: [`bill-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id
  // The first account on an instance is its owner and is not a customer of itself.
  await db().execute({ text: "UPDATE users SET is_owner = false WHERE id = $1", values: [userId] })
  cookie = `${SESSION_COOKIE}=${(await issueSession(userId)).token}`

  const plans = await db().all<Plan>({
    text: "SELECT * FROM plans WHERE yearly_cents > 0 ORDER BY yearly_cents LIMIT 1",
    values: [],
  })
  paid = plans[0]!
  free = (await db().one<Plan>({
    text: "SELECT * FROM plans WHERE yearly_cents = 0 AND monthly_cents = 0 LIMIT 1",
    values: [],
  }))!
})

afterAll(async () => {
  await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [userId] })
})

describe.skipIf(!isConfigured())("with a payment provider", () => {
  test("a payment method cannot be posted by the client", async () => {
    const res = await call("/api/billing/payment-methods", {
      method: "POST",
      body: JSON.stringify({
        provider: "stripe",
        provider_ref: "pm_made_up",
        brand: "Visa",
        last4: "4242",
      }),
    })
    expect(res.status).toBe(400)
    const rows = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM payment_methods WHERE user_id = $1",
      values: [userId],
    })
    expect(Number(rows?.count)).toBe(0)
  })

  test("a paid plan is not activated by a direct request", async () => {
    const res = await call("/api/subscription", {
      method: "POST",
      body: JSON.stringify({ plan_id: paid.id, interval: "yearly" }),
    })
    expect(res.status).toBe(400)
    const subs = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM subscriptions WHERE user_id = $1",
      values: [userId],
    })
    expect(Number(subs?.count)).toBe(0)
    const paidTx = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM transactions WHERE user_id = $1 AND status = 'paid'",
      values: [userId],
    })
    expect(Number(paidTx?.count)).toBe(0)
  })

  test("a free plan still can be", async () => {
    const res = await call("/api/subscription", {
      method: "POST",
      body: JSON.stringify({ plan_id: free.id }),
    })
    expect(res.status).toBe(200)
  })
})

describe.skipIf(isConfigured())("with no payment provider", () => {
  test("a payment method can be recorded by hand, and then a paid plan chosen", async () => {
    const added = await call("/api/billing/payment-methods", {
      method: "POST",
      body: JSON.stringify({
        provider: "manual",
        provider_ref: "ref",
        brand: "Visa",
        last4: "4242",
      }),
    })
    expect(added.status).toBe(201)
    const chosen = await call("/api/subscription", {
      method: "POST",
      body: JSON.stringify({ plan_id: paid.id, interval: "yearly" }),
    })
    expect(chosen.status).toBe(200)
  })
})
