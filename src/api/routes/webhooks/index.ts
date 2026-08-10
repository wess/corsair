import { from } from "@atlas/db"
import { post, type Route, text } from "@atlas/server"
import { allColumns, db } from "../../../db/index.ts"
import * as payments from "../../../payments/index.ts"
import {
  paymentEvents,
  paymentMethods,
  type Subscription,
  subscriptions,
  transactions,
  type User,
  users,
} from "../../../schema/index.ts"

/**
 * The payment provider's webhook.
 *
 * Unauthenticated by necessity — the provider has no session — which makes the
 * signature check the only thing standing between this endpoint and anyone who
 * can guess the URL granting themselves a subscription. It is verified before
 * the payload is parsed, let alone acted on.
 *
 * Every event is recorded before it is applied, keyed on the provider's own
 * event id. Providers retry aggressively and do resend events; without that
 * key, a retried `invoice.payment_succeeded` writes a second transaction row.
 */

const userByCustomerRef = async (ref: string | null): Promise<User | null> =>
  ref ? db().one<User>(from(users).where((q) => q("provider_customer_ref").equals(ref))) : null

const activeSubscription = (userId: string): Promise<Subscription | null> =>
  db().one<Subscription>(
    from(subscriptions).where((q) => [
      q("user_id").equals(userId),
      q("status").inList(["trialing", "active", "past_due"]),
    ]),
  )

const apply = async (event: ReturnType<typeof payments.parseWebhook>): Promise<void> => {
  const user = await userByCustomerRef(event.customerRef)
  if (!user) return

  switch (event.kind) {
    case "payment_method.attached": {
      if (!event.card) return
      const existing = await db().one<{ id: string }>(
        from(paymentMethods)
          .select("id")
          .where((q) => q("user_id").equals(user.id)),
      )
      await db().execute(
        from(paymentMethods).insert({
          user_id: user.id,
          provider: payments.providerName(),
          provider_ref: event.subscriptionRef ?? `${event.card.brand}-${event.card.last4}`,
          brand: event.card.brand,
          last4: event.card.last4,
          exp_month: event.card.expMonth,
          exp_year: event.card.expYear,
          // The first card on file becomes the default; a later one does not
          // silently displace the one the customer already chose.
          is_default: !existing,
        }),
      )
      return
    }

    case "subscription.active": {
      const current = await activeSubscription(user.id)
      if (!current) return
      await db().execute(
        from(subscriptions)
          .where((q) => q("id").equals(current.id))
          .update({
            status: "active",
            provider: payments.providerName(),
            provider_ref: event.subscriptionRef,
            cancel_at_period_end: false,
            cancelled_at: null,
            ...(event.periodEnd ? { current_period_end: event.periodEnd } : {}),
            updated_at: new Date(),
          }),
      )
      return
    }

    case "subscription.cancelled": {
      const current = await activeSubscription(user.id)
      if (!current) return
      await db().execute(
        from(subscriptions)
          .where((q) => q("id").equals(current.id))
          .update({ status: "cancelled", cancelled_at: new Date(), updated_at: new Date() }),
      )
      return
    }

    case "payment.succeeded": {
      const current = await activeSubscription(user.id)
      await db().execute(
        from(transactions).insert({
          user_id: user.id,
          subscription_id: current?.id ?? null,
          description: event.description ?? "Subscription payment",
          amount_cents: event.amountCents ?? 0,
          currency: event.currency ?? "usd",
          status: "paid",
          provider: payments.providerName(),
          provider_ref: event.subscriptionRef,
        }),
      )
      return
    }

    case "payment.failed": {
      const current = await activeSubscription(user.id)
      if (current) {
        // past_due rather than cancelled: the provider will retry, and cutting
        // mail off on a first failed charge is how you lose a customer over an
        // expired card.
        await db().execute(
          from(subscriptions)
            .where((q) => q("id").equals(current.id))
            .update({ status: "past_due", updated_at: new Date() }),
        )
      }
      await db().execute(
        from(transactions).insert({
          user_id: user.id,
          subscription_id: current?.id ?? null,
          description: "Subscription payment failed",
          amount_cents: event.amountCents ?? 0,
          currency: event.currency ?? "usd",
          status: "failed",
          provider: payments.providerName(),
          provider_ref: event.subscriptionRef,
        }),
      )
      return
    }

    default:
      return
  }
}

export const webhookRoutes: Route[] = [
  post("/api/webhooks/payments", async (c) => {
    // Read the body verbatim. The signature covers the exact bytes, so parsing
    // and re-serialising first would invalidate it.
    const payload = await c.request.text()
    const signature = c.headers.get("stripe-signature")

    if (!payments.verifyWebhook({ payload, signature })) {
      return text(c, 400, "invalid signature")
    }

    let eventRef = ""
    try {
      eventRef = String((JSON.parse(payload) as { id?: string }).id ?? "")
    } catch {
      return text(c, 400, "unparsable payload")
    }
    if (!eventRef) return text(c, 400, "missing event id")

    const event = payments.parseWebhook(payload)

    // The unique constraint is what makes this idempotent: a retried delivery
    // conflicts here and is acknowledged without being applied twice.
    const recorded = await db()
      .one<{ id: string }>(
        from(paymentEvents)
          .insert({
            provider: payments.providerName(),
            event_ref: eventRef,
            kind: event.kind,
            payload: JSON.parse(payload),
          })
          .returning(...allColumns(paymentEvents)),
      )
      .catch(() => null)

    if (!recorded) return text(c, 200, "already processed")

    try {
      await apply(event)
      await db().execute(
        from(paymentEvents)
          .where((q) => q("id").equals(recorded.id))
          .update({ processed_at: new Date() }),
      )
    } catch (e) {
      // Leaving processed_at null marks it for inspection. A 500 here would
      // make the provider retry, and the retry would be deduplicated above and
      // never applied — so answer 200 and surface the failure in the logs.
      console.error("[corsair] failed to apply a payment webhook:", e)
    }

    return text(c, 200, "ok")
  }),
]
