import { from } from "@atlas/db"
import { db, num } from "../db/index.ts"
import { planRequired, quotaExceeded } from "../errors/index.ts"
import {
  type Plan,
  type PlanFeatures,
  plans,
  type Subscription,
  subscriptions,
} from "../schema/index.ts"

export type Entitlement = {
  plan: Plan
  subscription: Subscription | null
  storageBytes: number
  dailyIn: number
  dailyOut: number
  features: PlanFeatures
}

const LIVE = ["trialing", "active", "past_due"]

/**
 * What an account is allowed to do right now.
 *
 * An account with no subscription falls back to the trial plan rather than to
 * nothing: a self-hosted instance that never configures billing should still
 * work, and "no row" is exactly the state a fresh install is in.
 */
export const entitlementOf = async (userId: string): Promise<Entitlement> => {
  const subscription = await db().one<Subscription>(
    from(subscriptions).where((q) => [q("user_id").equals(userId), q("status").inList(LIVE)]),
  )

  const plan = subscription
    ? await db().one<Plan>(from(plans).where((q) => q("id").equals(subscription.plan_id)))
    : await db().one<Plan>(
        from(plans)
          .where((q) => q("is_trial").equals(true))
          .orderBy("position", "ASC"),
      )

  if (!plan) {
    // No plans configured at all — an unmetered instance. Everything on, no
    // caps. This is a legitimate way to run a private server.
    const unlimited: Plan = {
      id: "00000000-0000-0000-0000-000000000000",
      key: "unlimited",
      name: "Unlimited",
      storage_bytes: BigInt(Number.MAX_SAFE_INTEGER),
      daily_in: 0,
      daily_out: 0,
      monthly_cents: 0,
      yearly_cents: 0,
      monthly_price_ref: null,
      yearly_price_ref: null,
      max_domains: null,
      max_addresses: null,
      features: {
        fallback_domains: true,
        self_service: true,
        custom_filters: true,
        transfers: true,
      },
      is_trial: false,
      visible: false,
      position: 0,
      created_at: new Date(),
    }
    return {
      plan: unlimited,
      subscription: null,
      storageBytes: Number.MAX_SAFE_INTEGER,
      dailyIn: 0,
      dailyOut: 0,
      features: unlimited.features,
    }
  }

  return {
    plan,
    subscription,
    storageBytes: num(plan.storage_bytes),
    dailyIn: plan.daily_in,
    dailyOut: plan.daily_out,
    features: plan.features ?? {},
  }
}

/** Throws a 402 the panel renders as an upgrade prompt. */
export const requireFeature = (
  entitlement: Entitlement,
  feature: keyof PlanFeatures,
  label: string,
): void => {
  if (!entitlement.features[feature]) throw planRequired(label)
}

// ------------------------------------------------------------------ usage --

export type Usage = {
  bytesUsed: number
  storageBytes: number
  domains: number
  addresses: number
  sentToday: number
  receivedToday: number
}

/**
 * A single round trip for everything the Overview screen and the delivery
 * limits both need. Written as one statement because the alternative is six,
 * and this runs on every inbound message.
 */
export const usageOf = async (userId: string): Promise<Usage> => {
  const entitlement = await entitlementOf(userId)
  const row = await db().one<{
    bytes_used: string
    domain_count: string
    address_count: string
    sent_today: string
    received_today: string
  }>({
    text: `
      SELECT
        coalesce((SELECT sum(a.bytes_used) FROM addresses a
                  JOIN domains d ON d.id = a.domain_id
                  WHERE d.user_id = $1), 0)::text AS bytes_used,
        (SELECT count(*) FROM domains WHERE user_id = $1)::text AS domain_count,
        coalesce((SELECT count(*) FROM addresses a
                  JOIN domains d ON d.id = a.domain_id
                  WHERE d.user_id = $1), 0)::text AS address_count,
        (SELECT count(*) FROM mail_log
          WHERE user_id = $1 AND direction = 'outbound'
            AND created_at > now() - interval '1 day')::text AS sent_today,
        (SELECT count(*) FROM mail_log
          WHERE user_id = $1 AND direction = 'inbound' AND status = 'accepted'
            AND created_at > now() - interval '1 day')::text AS received_today
    `,
    values: [userId],
  })

  return {
    bytesUsed: Number(row?.bytes_used ?? 0),
    storageBytes: entitlement.storageBytes,
    domains: Number(row?.domain_count ?? 0),
    addresses: Number(row?.address_count ?? 0),
    sentToday: Number(row?.sent_today ?? 0),
    receivedToday: Number(row?.received_today ?? 0),
  }
}

export const assertStorageAvailable = async (userId: string, incoming: number): Promise<void> => {
  const usage = await usageOf(userId)
  if (usage.bytesUsed + incoming <= usage.storageBytes) return
  throw quotaExceeded(
    `This account has used ${formatBytes(usage.bytesUsed)} of its ${formatBytes(usage.storageBytes)} of storage.`,
  )
}

/**
 * Daily send and receive caps. A limit of zero means unmetered — that is how
 * the "unlimited" fallback plan above is expressed, and it keeps the check a
 * single comparison rather than a null dance.
 */
export const withinDailyLimit = async (
  userId: string,
  direction: "inbound" | "outbound",
  addressOverride?: number | null,
): Promise<{ ok: boolean; limit: number; used: number }> => {
  const entitlement = await entitlementOf(userId)
  const limit =
    addressOverride ?? (direction === "outbound" ? entitlement.dailyOut : entitlement.dailyIn)
  if (!limit) return { ok: true, limit: 0, used: 0 }

  const row = await db().one<{ count: string }>({
    text: `SELECT count(*)::text AS count FROM mail_log
           WHERE user_id = $1 AND direction = $2 AND created_at > now() - interval '1 day'`,
    values: [userId, direction],
  })
  const used = Number(row?.count ?? 0)
  return { ok: used < limit, limit, used }
}

export const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}
