import { from } from "@atlas/db"
import { hashPassword } from "../src/auth/index.ts"
import { config } from "../src/config/index.ts"
import { allColumns, db } from "../src/db/index.ts"
import { referralCode } from "../src/ids/index.ts"
import { type Plan, plans, subscriptions, type User, users } from "../src/schema/index.ts"

const GB = 1024 * 1024 * 1024

/**
 * The default plan ladder. Plans are rows, not constants, so a self-hoster can
 * price or delete them freely — these exist so a fresh install has something
 * coherent to show rather than an empty Plans screen.
 */
const DEFAULT_PLANS = [
  {
    key: "trial",
    name: "Free Trial",
    storage_bytes: BigInt(1 * GB),
    daily_in: 200,
    daily_out: 20,
    monthly_cents: 0,
    yearly_cents: 0,
    max_domains: 1,
    max_addresses: 3,
    features: {},
    is_trial: true,
    position: 0,
  },
  {
    key: "startup",
    name: "Startup",
    storage_bytes: BigInt(5 * GB),
    daily_in: 200,
    daily_out: 50,
    monthly_cents: 150,
    yearly_cents: 1800,
    max_domains: null,
    max_addresses: null,
    features: { transfers: true },
    is_trial: false,
    position: 1,
  },
  {
    key: "small_business",
    name: "Small Business",
    storage_bytes: BigInt(30 * GB),
    daily_in: 1000,
    daily_out: 100,
    monthly_cents: 500,
    yearly_cents: 6000,
    max_domains: null,
    max_addresses: null,
    features: { transfers: true, custom_filters: true, self_service: true },
    is_trial: false,
    position: 2,
  },
  {
    key: "mini_tycoon",
    name: "Mini Tycoon",
    storage_bytes: BigInt(100 * GB),
    daily_in: 3000,
    daily_out: 500,
    monthly_cents: 1500,
    yearly_cents: 18000,
    max_domains: null,
    max_addresses: null,
    features: {
      transfers: true,
      custom_filters: true,
      self_service: true,
      fallback_domains: true,
    },
    is_trial: false,
    position: 3,
  },
]

export const seedPlans = async (): Promise<Plan[]> => {
  const out: Plan[] = []
  for (const spec of DEFAULT_PLANS) {
    const existing = await db().one<Plan>(from(plans).where((q) => q("key").equals(spec.key)))
    if (existing) {
      out.push(existing)
      continue
    }
    const row = await db().one<Plan>(
      from(plans)
        .insert(spec)
        .returning(...allColumns(plans)),
    )
    if (row) out.push(row)
  }
  return out
}

export const seed = async (): Promise<void> => {
  const created = await seedPlans()
  console.log(`plans: ${created.map((p) => p.key).join(", ")}`)

  const email = process.env.SEED_EMAIL ?? "admin@corsair.local"
  const password = process.env.SEED_PASSWORD ?? "corsair-dev-password"

  const existing = await db().one<{ id: string }>(
    from(users)
      .select("id")
      .where((q) => q("email").equals(email)),
  )
  if (existing) {
    console.log(`user ${email} already exists — nothing else to do`)
    return
  }

  // The first account owns the instance. The claim is made inside the INSERT so
  // two concurrent signups cannot both win it; the partial unique index is what
  // actually decides.
  const user = (await db().one<User>({
    text: `INSERT INTO users (email, password_hash, name, referral_code, email_verified_at, is_owner)
           VALUES ($1, $2, $3, $4, now(), NOT EXISTS (SELECT 1 FROM users))
           RETURNING *`,
    values: [email, await hashPassword(password), "Admin", referralCode()],
  }))!

  const trial = created.find((p) => p.is_trial) ?? created[0]
  if (trial) {
    await db().execute(
      from(subscriptions).insert({
        user_id: user.id,
        plan_id: trial.id,
        status: "trialing",
        interval: "yearly",
        current_period_end: new Date(Date.now() + 30 * 86_400_000),
      }),
    )
  }

  console.log(`
  owner     ${user.is_owner ? "yes — this account owns the instance" : "no"}
  user      ${email}
  password  ${password}
  panel     ${config.publicUrl}/app

  Add a domain, publish the DNS records it shows you, then create a mailbox.
`)
}

if (import.meta.main) {
  await seed()
  const { closeDb } = await import("../src/db/index.ts")
  await closeDb()
}
