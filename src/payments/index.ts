import { createHmac, timingSafeEqual } from "node:crypto"
import { config } from "../config/index.ts"

/**
 * Payment provider integration.
 *
 * Card details never reach this server. The panel sends the customer to the
 * provider's own hosted page, the provider tells us what happened over a signed
 * webhook, and all Corsair ever stores is a brand, four digits, and the
 * provider's opaque reference. There is deliberately no code path here that
 * could accept a card number — that is what keeps this out of PCI scope.
 *
 * A self-hosted instance with no provider configured runs in `manual` mode:
 * plans still gate features and the panel still records payment methods that an
 * operator enters by hand, but nothing is charged. That is the correct default
 * for somebody hosting mail for themselves.
 */

export type ProviderName = "stripe" | "manual"

export const providerName = (): ProviderName =>
  config.payments.stripeSecretKey ? "stripe" : "manual"

export const isConfigured = (): boolean => providerName() !== "manual"

export type CheckoutSession = { url: string; reference: string }

export type ProviderCustomer = { reference: string }

export type WebhookEvent = {
  kind:
    | "payment_method.attached"
    | "subscription.active"
    | "subscription.cancelled"
    | "payment.succeeded"
    | "payment.failed"
    | "ignored"
  customerRef: string | null
  subscriptionRef: string | null
  /** Set on payment events, in the smallest currency unit. */
  amountCents?: number
  currency?: string
  description?: string
  card?: { brand: string; last4: string; expMonth: number | null; expYear: number | null }
  periodEnd?: Date
}

// -------------------------------------------------------------- Stripe --

const STRIPE = "https://api.stripe.com/v1"

const form = (values: Record<string, string | number | undefined>): string => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    params.set(key, String(value))
  }
  return params.toString()
}

const stripeCall = async <T>(
  path: string,
  init: { method?: string; body?: Record<string, string | number | undefined> } = {},
): Promise<T> => {
  const response = await fetch(`${STRIPE}${path}`, {
    method: init.method ?? "GET",
    headers: {
      authorization: `Bearer ${config.payments.stripeSecretKey}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    ...(init.body ? { body: form(init.body) } : {}),
  })

  const body = (await response.json()) as { error?: { message?: string } }
  if (!response.ok) {
    throw new Error(body.error?.message ?? `Stripe returned HTTP ${response.status}`)
  }
  return body as T
}

export const createCustomer = async (input: {
  email: string
  name: string | null
  userId: string
}): Promise<ProviderCustomer> => {
  if (!isConfigured()) return { reference: `manual_${input.userId}` }

  const customer = await stripeCall<{ id: string }>("/customers", {
    method: "POST",
    body: {
      email: input.email,
      name: input.name ?? undefined,
      // Lets a webhook be traced back to an account without a lookup table.
      "metadata[corsair_user_id]": input.userId,
    },
  })
  return { reference: customer.id }
}

/**
 * A hosted page for adding a card. The customer never types card details into
 * anything Corsair serves.
 */
export const createSetupSession = async (input: {
  customerRef: string
  returnUrl: string
}): Promise<CheckoutSession> => {
  const session = await stripeCall<{ id: string; url: string }>("/checkout/sessions", {
    method: "POST",
    body: {
      mode: "setup",
      customer: input.customerRef,
      success_url: `${input.returnUrl}?setup=ok`,
      cancel_url: `${input.returnUrl}?setup=cancelled`,
    },
  })
  return { url: session.url, reference: session.id }
}

/** A hosted page for starting or changing a paid subscription. */
export const createSubscriptionSession = async (input: {
  customerRef: string
  priceRef: string
  returnUrl: string
}): Promise<CheckoutSession> => {
  const session = await stripeCall<{ id: string; url: string }>("/checkout/sessions", {
    method: "POST",
    body: {
      mode: "subscription",
      customer: input.customerRef,
      "line_items[0][price]": input.priceRef,
      "line_items[0][quantity]": 1,
      success_url: `${input.returnUrl}?checkout=ok`,
      cancel_url: `${input.returnUrl}?checkout=cancelled`,
    },
  })
  return { url: session.url, reference: session.id }
}

export const cancelSubscription = async (subscriptionRef: string): Promise<void> => {
  if (!isConfigured()) return
  // Cancelled at period end, not immediately: the customer paid for the rest of
  // the period and cutting mail off mid-month is a support ticket.
  await stripeCall(`/subscriptions/${subscriptionRef}`, {
    method: "POST",
    body: { cancel_at_period_end: "true" },
  })
}

// ------------------------------------------------------------- webhooks --

/**
 * Verifies Stripe's `Stripe-Signature` header.
 *
 * A webhook endpoint that does not verify its signature is an unauthenticated
 * endpoint that grants subscriptions — anyone who can guess the URL can upgrade
 * themselves. The timestamp check is what stops a captured payload being
 * replayed later.
 */
export const verifyWebhook = (input: {
  payload: string
  signature: string | null
  toleranceSeconds?: number
  /** Overridable so the check can be tested without a live configuration. */
  secret?: string
}): boolean => {
  const secret = input.secret ?? config.payments.stripeWebhookSecret
  if (!secret || !input.signature) return false

  const parts = Object.fromEntries(
    input.signature.split(",").map((p) => {
      const eq = p.indexOf("=")
      return [p.slice(0, eq).trim(), p.slice(eq + 1).trim()]
    }),
  ) as { t?: string; v1?: string }

  if (!parts.t || !parts.v1) return false

  const age = Math.abs(Date.now() / 1000 - Number(parts.t))
  if (age > (input.toleranceSeconds ?? 300)) return false

  const expected = createHmac("sha256", secret).update(`${parts.t}.${input.payload}`).digest("hex")

  const a = Buffer.from(expected)
  const b = Buffer.from(parts.v1)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Maps a Stripe event onto the small set of things Corsair acts on. */
export const parseWebhook = (payload: string): WebhookEvent => {
  const event = JSON.parse(payload) as {
    type?: string
    data?: { object?: Record<string, any> }
  }
  const object = event.data?.object ?? {}
  const customerRef = (object.customer as string) ?? null

  switch (event.type) {
    case "payment_method.attached": {
      const card = object.card as Record<string, any> | undefined
      return {
        kind: "payment_method.attached",
        customerRef,
        subscriptionRef: null,
        card: {
          brand: String(card?.brand ?? "card"),
          last4: String(card?.last4 ?? "0000"),
          expMonth: card?.exp_month ?? null,
          expYear: card?.exp_year ?? null,
        },
      }
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const status = String(object.status ?? "")
      const active = status === "active" || status === "trialing"
      return {
        kind: active ? "subscription.active" : "subscription.cancelled",
        customerRef,
        subscriptionRef: (object.id as string) ?? null,
        periodEnd: object.current_period_end
          ? new Date(Number(object.current_period_end) * 1000)
          : undefined,
      }
    }

    case "customer.subscription.deleted":
      return {
        kind: "subscription.cancelled",
        customerRef,
        subscriptionRef: (object.id as string) ?? null,
      }

    case "invoice.payment_succeeded":
      return {
        kind: "payment.succeeded",
        customerRef,
        subscriptionRef: (object.subscription as string) ?? null,
        amountCents: Number(object.amount_paid ?? 0),
        currency: String(object.currency ?? "usd"),
        description: String(object.description ?? "Subscription payment"),
      }

    case "invoice.payment_failed":
      return {
        kind: "payment.failed",
        customerRef,
        subscriptionRef: (object.subscription as string) ?? null,
        amountCents: Number(object.amount_due ?? 0),
        currency: String(object.currency ?? "usd"),
      }

    default:
      // Stripe sends a great many event types. Ignoring the rest explicitly is
      // better than a 500 that makes Stripe retry forever.
      return { kind: "ignored", customerRef, subscriptionRef: null }
  }
}
