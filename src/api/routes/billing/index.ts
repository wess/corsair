import { from } from "@atlas/db"
import { delR, getR, json, postR, putR, type Route } from "@atlas/server"
import { z } from "zod"
import { config } from "../../../config/index.ts"
import { allColumns, db } from "../../../db/index.ts"
import { conflict, invalidParameter, notFound } from "../../../errors/index.ts"
import { paginate, parsePageQuery } from "../../../pagination/index.ts"
import * as payments from "../../../payments/index.ts"
import { entitlementOf, usageOf } from "../../../plans/index.ts"
import {
  type PaymentMethod,
  type Plan,
  paymentMethods,
  plans,
  type Subscription,
  subscriptions,
  type TaxId,
  type Transaction,
  taxIds,
  transactions,
  type User,
  users,
} from "../../../schema/index.ts"
import {
  entitlementObject,
  paymentMethodObject,
  planObject,
  subscriptionObject,
  taxIdObject,
  transactionObject,
} from "../../../serialize/index.ts"
import { authed, authedWithPlan, entitlementFrom, principalOf } from "../../pipes/index.ts"

const LIVE = ["trialing", "active", "past_due"]

const activeSubscription = (userId: string): Promise<Subscription | null> =>
  db().one<Subscription>(
    from(subscriptions).where((q) => [q("user_id").equals(userId), q("status").inList(LIVE)]),
  )

/**
 * The provider's customer record for this account, created on first need.
 * Doing it lazily means an instance that never configures a provider never
 * talks to one.
 */
const customerRefFor = async (userId: string): Promise<string> => {
  const user = await db().one<User>(from(users).where((q) => q("id").equals(userId)))
  if (!user) throw notFound("Account not found.")
  if (user.provider_customer_ref) return user.provider_customer_ref

  const created = await payments.createCustomer({
    email: user.email,
    name: user.name,
    userId: user.id,
  })
  await db().execute(
    from(users)
      .where((q) => q("id").equals(user.id))
      .update({ provider_customer_ref: created.reference, updated_at: new Date() }),
  )
  return created.reference
}

export const billingRoutes: Route[] = [
  getR("/api/plans", { before: authed, assigns: {} as never }, async (c) => {
    const rows = await db().all<Plan>(
      from(plans)
        .where((q) => q("visible").equals(true))
        .orderBy("position", "ASC"),
    )
    const current = await activeSubscription(principalOf(c).userId)

    // The owner has no subscription row and never will — their entitlement is
    // computed, not sold. Reporting `null` here left the panel marking the free
    // trial as active and offering to sell them their own server.
    const entitlement = await entitlementOf(principalOf(c).userId)
    const owned = await db().one<{ is_owner: boolean }>(
      from(users)
        .select("is_owner")
        .where((q) => q("id").equals(principalOf(c).userId)),
    )

    return json(c, 200, {
      object: "list",
      data: rows.map(planObject),
      current_plan_id: current?.plan_id ?? (owned?.is_owner ? entitlement.plan.id : null),
      owner: Boolean(owned?.is_owner),
    })
  }),

  getR("/api/entitlement", { before: authedWithPlan, assigns: {} as never }, async (c) =>
    json(c, 200, entitlementObject(entitlementFrom(c), await usageOf(principalOf(c).userId))),
  ),

  postR(
    "/api/subscription",
    {
      body: z.object({
        plan_id: z.string().uuid(),
        interval: z.enum(["monthly", "yearly"]).optional(),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const plan = await db().one<Plan>(from(plans).where((q) => q("id").equals(c.body.plan_id)))
      if (!plan) throw notFound("Plan not found.")

      const interval = c.body.interval ?? "yearly"
      const price = interval === "monthly" ? plan.monthly_cents : plan.yearly_cents

      // Anything that costs money needs a payment method on file. A free or
      // trial plan does not, which is what makes a self-hosted instance with no
      // payment provider usable.
      if (price > 0) {
        const method = await db().one<PaymentMethod>(
          from(paymentMethods).where((q) => q("user_id").equals(principalOf(c).userId)),
        )
        if (!method) throw invalidParameter("Add a payment method before choosing a paid plan.")
      }

      const existing = await activeSubscription(principalOf(c).userId)
      const periodEnd = new Date(Date.now() + (interval === "monthly" ? 30 : 365) * 86_400_000)

      const saved = existing
        ? await db().one<Subscription>(
            from(subscriptions)
              .where((q) => q("id").equals(existing.id))
              .update({
                plan_id: plan.id,
                interval,
                status: price > 0 ? "active" : "trialing",
                current_period_start: new Date(),
                current_period_end: periodEnd,
                cancel_at_period_end: false,
                cancelled_at: null,
                updated_at: new Date(),
              })
              .returning(...allColumns(subscriptions)),
          )
        : await db().one<Subscription>(
            from(subscriptions)
              .insert({
                user_id: principalOf(c).userId,
                plan_id: plan.id,
                interval,
                status: price > 0 ? "active" : "trialing",
                current_period_end: periodEnd,
              })
              .returning(...allColumns(subscriptions)),
          )

      if (price > 0) {
        await db().execute(
          from(transactions).insert({
            user_id: principalOf(c).userId,
            subscription_id: saved!.id,
            description: `${interval === "monthly" ? "1 mo." : "12 mo."} ${plan.name} Plan`,
            amount_cents: price,
            status: "paid",
          }),
        )
      }

      return json(c, 200, subscriptionObject(saved!, plan))
    },
  ),

  postR("/api/subscription/cancel", { before: authed, assigns: {} as never }, async (c) => {
    const existing = await activeSubscription(principalOf(c).userId)
    if (!existing) throw notFound("There is no active subscription.")

    // Cancelled at the period end, not immediately: the customer paid for the
    // rest of the period, and cutting mail off mid-month is a support ticket.
    const saved = await db().one<Subscription>(
      from(subscriptions)
        .where((q) => q("id").equals(existing.id))
        .update({ cancel_at_period_end: true, cancelled_at: new Date(), updated_at: new Date() })
        .returning(...allColumns(subscriptions)),
    )
    return json(c, 200, subscriptionObject(saved!))
  }),

  /** Whether this instance can actually charge, so the panel knows what to show. */
  getR("/api/billing/provider", { before: authed, assigns: {} as never }, async (c) =>
    json(c, 200, {
      object: "payment_provider",
      name: payments.providerName(),
      configured: payments.isConfigured(),
    }),
  ),

  /**
   * A hosted page for adding a card. Corsair never sees the card — the customer
   * enters it on the provider's own page and a webhook tells us the result.
   */
  postR("/api/billing/checkout/setup", { before: authed, assigns: {} as never }, async (c) => {
    if (!payments.isConfigured()) {
      throw invalidParameter(
        "No payment provider is configured on this server. Payment methods can be recorded manually instead.",
      )
    }
    const session = await payments.createSetupSession({
      customerRef: await customerRefFor(principalOf(c).userId),
      returnUrl: `${config.publicUrl}/app/billing`,
    })
    return json(c, 200, { object: "checkout_session", url: session.url })
  }),

  postR(
    "/api/billing/checkout/subscription",
    {
      body: z.object({
        plan_id: z.string().uuid(),
        interval: z.enum(["monthly", "yearly"]).optional(),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      if (!payments.isConfigured()) {
        throw invalidParameter("No payment provider is configured on this server.")
      }
      const plan = await db().one<Plan>(from(plans).where((q) => q("id").equals(c.body.plan_id)))
      if (!plan) throw notFound("Plan not found.")

      const interval = c.body.interval ?? "yearly"
      const priceRef = interval === "monthly" ? plan.monthly_price_ref : plan.yearly_price_ref
      if (!priceRef) {
        throw invalidParameter(
          `The ${plan.name} plan has no ${interval} price configured with the payment provider.`,
        )
      }

      const session = await payments.createSubscriptionSession({
        customerRef: await customerRefFor(principalOf(c).userId),
        priceRef,
        returnUrl: `${config.publicUrl}/app/plans`,
      })
      return json(c, 200, { object: "checkout_session", url: session.url })
    },
  ),

  getR("/api/billing/transactions", { before: authed, assigns: {} as never }, async (c) => {
    const page = await paginate<Transaction>({
      source: "transactions",
      columns: "*",
      where: "user_id = $1",
      values: [principalOf(c).userId],
      searchColumns: ["description"],
      sortable: { description: "description", amount: "amount_cents", date: "transaction_date" },
      defaultSort: "transaction_date",
      query: {
        ...parsePageQuery((c.query ?? {}) as Record<string, string>),
        direction: ((c.query ?? {}) as Record<string, string>).direction === "asc" ? "asc" : "desc",
      },
    })
    return json(c, 200, { ...page, data: page.data.map(transactionObject) })
  }),

  getR(
    "/api/billing/transactions/:transaction_id",
    {
      params: z.object({ transaction_id: z.string().uuid() }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const row = await db().one<Transaction>(
        from(transactions).where((q) => [
          q("id").equals(c.params.transaction_id),
          q("user_id").equals(principalOf(c).userId),
        ]),
      )
      if (!row) throw notFound("Transaction not found.")
      return json(c, 200, transactionObject(row))
    },
  ),

  getR("/api/billing/payment-methods", { before: authed, assigns: {} as never }, async (c) => {
    const rows = await db().all<PaymentMethod>(
      from(paymentMethods)
        .where((q) => q("user_id").equals(principalOf(c).userId))
        .orderBy("created_at", "DESC"),
    )
    return json(c, 200, { object: "list", data: rows.map(paymentMethodObject) })
  }),

  postR(
    "/api/billing/payment-methods",
    {
      body: z.object({
        provider: z.string().max(40),
        provider_ref: z.string().max(200),
        brand: z.string().max(40),
        last4: z.string().length(4),
        exp_month: z.number().int().min(1).max(12).optional(),
        exp_year: z.number().int().min(2024).max(2100).optional(),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      /**
       * Only the display fields a payment provider hands back are accepted —
       * there is no field here that could carry a card number, by design. The
       * card itself never reaches this server; the client tokenises it with the
       * provider and posts the resulting reference.
       */
      const existing = await db().one<PaymentMethod>(
        from(paymentMethods).where((q) => [
          q("user_id").equals(principalOf(c).userId),
          q("is_default").equals(true),
        ]),
      )

      const row = await db().one<PaymentMethod>(
        from(paymentMethods)
          .insert({
            user_id: principalOf(c).userId,
            provider: c.body.provider,
            provider_ref: c.body.provider_ref,
            brand: c.body.brand,
            last4: c.body.last4,
            exp_month: c.body.exp_month ?? null,
            exp_year: c.body.exp_year ?? null,
            is_default: !existing,
          })
          .returning(...allColumns(paymentMethods)),
      )
      return json(c, 201, paymentMethodObject(row!))
    },
  ),

  postR(
    "/api/billing/payment-methods/:method_id/default",
    { params: z.object({ method_id: z.string().uuid() }), before: authed, assigns: {} as never },
    async (c) => {
      const row = await db().one<PaymentMethod>(
        from(paymentMethods).where((q) => [
          q("id").equals(c.params.method_id),
          q("user_id").equals(principalOf(c).userId),
        ]),
      )
      if (!row) throw notFound("Payment method not found.")

      // Clear first: a partial unique index allows one default per account.
      await db().execute(
        from(paymentMethods)
          .where((q) => q("user_id").equals(principalOf(c).userId))
          .update({ is_default: false }),
      )
      const saved = await db().one<PaymentMethod>(
        from(paymentMethods)
          .where((q) => q("id").equals(row.id))
          .update({ is_default: true })
          .returning(...allColumns(paymentMethods)),
      )
      return json(c, 200, paymentMethodObject(saved!))
    },
  ),

  delR(
    "/api/billing/payment-methods/:method_id",
    { params: z.object({ method_id: z.string().uuid() }), before: authed, assigns: {} as never },
    async (c) => {
      const row = await db().one<PaymentMethod>(
        from(paymentMethods).where((q) => [
          q("id").equals(c.params.method_id),
          q("user_id").equals(principalOf(c).userId),
        ]),
      )
      if (!row) throw notFound("Payment method not found.")

      const subscription = await activeSubscription(principalOf(c).userId)
      if (subscription && row.is_default) {
        const other = await db().one<PaymentMethod>(
          from(paymentMethods).where((q) => [
            q("user_id").equals(principalOf(c).userId),
            q("id").notEquals(row.id),
          ]),
        )
        if (!other) {
          throw conflict("Cancel the subscription before removing the only payment method.")
        }
        await db().execute(
          from(paymentMethods)
            .where((q) => q("id").equals(other.id))
            .update({ is_default: true }),
        )
      }

      await db().execute(
        from(paymentMethods)
          .where((q) => q("id").equals(row.id))
          .del(),
      )
      return json(c, 200, { object: "payment_method", id: row.id, deleted: true })
    },
  ),

  getR("/api/billing/tax-id", { before: authed, assigns: {} as never }, async (c) => {
    const row = await db().one<TaxId>(
      from(taxIds).where((q) => q("user_id").equals(principalOf(c).userId)),
    )
    return json(c, 200, row ? taxIdObject(row) : { object: "tax_id", id: null })
  }),

  putR(
    "/api/billing/tax-id",
    {
      body: z.object({
        kind: z.string().max(40),
        value: z.string().max(80),
        country: z.string().max(2).nullable().optional(),
        business_name: z.string().max(200).nullable().optional(),
        address_line: z.string().max(300).nullable().optional(),
      }),
      before: authed,
      assigns: {} as never,
    },
    async (c) => {
      const existing = await db().one<TaxId>(
        from(taxIds).where((q) => q("user_id").equals(principalOf(c).userId)),
      )
      const values = {
        kind: c.body.kind,
        value: c.body.value,
        country: c.body.country ?? null,
        business_name: c.body.business_name ?? null,
        address_line: c.body.address_line ?? null,
      }

      const row = existing
        ? await db().one<TaxId>(
            from(taxIds)
              .where((q) => q("id").equals(existing.id))
              .update({ ...values, updated_at: new Date() })
              .returning(...allColumns(taxIds)),
          )
        : await db().one<TaxId>(
            from(taxIds)
              .insert({ user_id: principalOf(c).userId, ...values })
              .returning(...allColumns(taxIds)),
          )
      return json(c, 200, taxIdObject(row!))
    },
  ),
]
