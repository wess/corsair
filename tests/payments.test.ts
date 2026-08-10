import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"
import { parseWebhook, verifyWebhook } from "../src/payments/index.ts"

/**
 * The signature check is the only thing standing between the webhook endpoint
 * and anyone who can guess its URL granting themselves a subscription, so it
 * gets the same scrutiny as an auth check.
 */

const secret = "whsec_test"

const sign = (payload: string, at = Math.floor(Date.now() / 1000)): string => {
  const v1 = createHmac("sha256", secret).update(`${at}.${payload}`).digest("hex")
  return `t=${at},v1=${v1}`
}

describe("webhook signatures", () => {
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.payment_succeeded" })

  test("accepts a correctly signed payload", () => {
    expect(verifyWebhook({ payload, signature: sign(payload), secret })).toBe(true)
  })

  test("rejects a tampered payload", () => {
    const signature = sign(payload)
    const tampered = JSON.stringify({ id: "evt_1", type: "customer.subscription.created" })
    expect(verifyWebhook({ payload: tampered, signature, secret })).toBe(false)
  })

  test("rejects a forged signature", () => {
    expect(verifyWebhook({ payload, signature: "t=1,v1=deadbeef", secret })).toBe(false)
  })

  test("rejects a missing signature", () => {
    expect(verifyWebhook({ payload, signature: null, secret })).toBe(false)
  })

  test("rejects a replayed payload outside the tolerance", () => {
    const old = Math.floor(Date.now() / 1000) - 3600
    expect(verifyWebhook({ payload, signature: sign(payload, old), secret })).toBe(false)
    // Still valid inside a wider window, so the check is on age, not on shape.
    expect(
      verifyWebhook({ payload, signature: sign(payload, old), secret, toleranceSeconds: 7200 }),
    ).toBe(true)
  })

  test("rejects everything when no secret is configured", () => {
    // An unconfigured instance must not accept webhooks at all, rather than
    // accepting them unverified.
    expect(verifyWebhook({ payload, signature: sign(payload), secret: "" })).toBe(false)
  })
})

describe("webhook parsing", () => {
  test("reads an attached card", () => {
    const event = parseWebhook(
      JSON.stringify({
        id: "evt_2",
        type: "payment_method.attached",
        data: {
          object: {
            customer: "cus_1",
            card: { brand: "visa", last4: "4242", exp_month: 4, exp_year: 2030 },
          },
        },
      }),
    )
    expect(event.kind).toBe("payment_method.attached")
    expect(event.customerRef).toBe("cus_1")
    expect(event.card).toEqual({ brand: "visa", last4: "4242", expMonth: 4, expYear: 2030 })
  })

  test("treats an active subscription as active", () => {
    const event = parseWebhook(
      JSON.stringify({
        id: "evt_3",
        type: "customer.subscription.updated",
        data: {
          object: {
            id: "sub_1",
            customer: "cus_1",
            status: "active",
            current_period_end: 1900000000,
          },
        },
      }),
    )
    expect(event.kind).toBe("subscription.active")
    expect(event.subscriptionRef).toBe("sub_1")
    expect(event.periodEnd?.getTime()).toBe(1900000000 * 1000)
  })

  test("treats any other subscription status as cancelled", () => {
    const event = parseWebhook(
      JSON.stringify({
        id: "evt_4",
        type: "customer.subscription.updated",
        data: { object: { id: "sub_1", customer: "cus_1", status: "incomplete_expired" } },
      }),
    )
    expect(event.kind).toBe("subscription.cancelled")
  })

  test("reads a successful payment with its amount", () => {
    const event = parseWebhook(
      JSON.stringify({
        id: "evt_5",
        type: "invoice.payment_succeeded",
        data: {
          object: { customer: "cus_1", subscription: "sub_1", amount_paid: 1800, currency: "usd" },
        },
      }),
    )
    expect(event.kind).toBe("payment.succeeded")
    expect(event.amountCents).toBe(1800)
  })

  test("ignores event types it does not act on", () => {
    const event = parseWebhook(
      JSON.stringify({ id: "evt_6", type: "charge.dispute.created", data: { object: {} } }),
    )
    // Ignoring explicitly beats a 500 that makes the provider retry forever.
    expect(event.kind).toBe("ignored")
  })
})
