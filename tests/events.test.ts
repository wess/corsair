import { describe, expect, test } from "bun:test"
import {
  EVENT_TYPES,
  isEventType,
  signatureHeaders,
  signingSecret,
  signPayload,
  subscribes,
  verifySignature,
} from "../src/events/index.ts"

/**
 * The signature is the only thing that tells a receiver a delivery came from
 * this server rather than from anybody who learned the URL, so it gets the same
 * scrutiny as an auth check.
 */

const secret = signingSecret()
const body = JSON.stringify({ type: "message.received", data: { recipient: "a@b.test" } })

describe("secrets", () => {
  test("are prefixed and base64, matching the Standard Webhooks convention", () => {
    expect(secret).toStartWith("whsec_")
    expect(() => Buffer.from(secret.slice(6), "base64")).not.toThrow()
  })

  test("are not reused between endpoints", () => {
    expect(signingSecret()).not.toBe(signingSecret())
  })
})

describe("signature headers", () => {
  const id = "msg_test123"
  const headers = signatureHeaders(secret, id, body)

  test("carry the standard trio", () => {
    expect(headers["webhook-id"]).toBe(id)
    expect(headers["webhook-signature"]).toStartWith("v1,")
    expect(Number(headers["webhook-timestamp"])).toBeGreaterThan(0)
  })

  test("carry svix aliases so off-the-shelf verifiers work unchanged", () => {
    expect(headers["svix-id"]).toBe(headers["webhook-id"])
    expect(headers["svix-signature"]).toBe(headers["webhook-signature"])
    expect(headers["svix-timestamp"]).toBe(headers["webhook-timestamp"])
  })

  test("the timestamp is in seconds, not milliseconds", () => {
    // A receiver comparing against its own clock in seconds would otherwise
    // reject every delivery as impossibly far in the future.
    const ts = Number(headers["webhook-timestamp"])
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(5)
  })
})

describe("verification", () => {
  const id = "msg_test123"

  const verify = (over: Partial<Parameters<typeof verifySignature>[0]> = {}) => {
    const headers = signatureHeaders(secret, id, body)
    return verifySignature({
      secret,
      id,
      timestamp: headers["webhook-timestamp"]!,
      signature: headers["webhook-signature"]!,
      body,
      ...over,
    })
  }

  test("accepts a delivery this server signed", () => {
    expect(verify()).toBe(true)
  })

  test("rejects a tampered body", () => {
    expect(verify({ body: JSON.stringify({ type: "message.received", data: {} }) })).toBe(false)
  })

  test("rejects a different event id", () => {
    // The id is inside the signed payload, so a replayed body under a new id
    // does not verify.
    expect(verify({ id: "msg_other" })).toBe(false)
  })

  test("rejects the wrong secret", () => {
    expect(verify({ secret: signingSecret() })).toBe(false)
  })

  test("rejects a forged signature", () => {
    expect(verify({ signature: "v1,not-a-real-signature" })).toBe(false)
  })

  test("rejects a replay outside the tolerance", () => {
    const old = Math.floor(Date.now() / 1000) - 3600
    const signature = signPayload(secret, id, old, body)
    expect(verifySignature({ secret, id, timestamp: String(old), signature, body })).toBe(false)
    expect(
      verifySignature({
        secret,
        id,
        timestamp: String(old),
        signature,
        body,
        toleranceSeconds: 7200,
      }),
    ).toBe(true)
  })

  test("accepts one of several space-separated signatures, for rotation", () => {
    const headers = signatureHeaders(secret, id, body)
    const mixed = `v1,someoldsignature ${headers["webhook-signature"]}`
    expect(
      verifySignature({
        secret,
        id,
        timestamp: headers["webhook-timestamp"]!,
        signature: mixed,
        body,
      }),
    ).toBe(true)
  })

  test("rejects a non-numeric timestamp", () => {
    expect(verify({ timestamp: "not-a-number" })).toBe(false)
  })
})

describe("subscriptions", () => {
  test("an exact type matches only itself", () => {
    expect(subscribes(["message.received"], "message.received")).toBe(true)
    expect(subscribes(["message.received"], "message.bounced")).toBe(false)
  })

  test("a family wildcard matches the whole family", () => {
    expect(subscribes(["message.*"], "message.bounced")).toBe(true)
    expect(subscribes(["message.*"], "domain.verified")).toBe(false)
  })

  test("the catch-all matches everything", () => {
    for (const type of EVENT_TYPES) expect(subscribes(["*"], type)).toBe(true)
  })

  test("an empty subscription list means everything", () => {
    // A hook created without an explicit list should not silently receive
    // nothing — that is the failure mode nobody notices.
    expect(subscribes([], "message.received")).toBe(true)
  })

  test("several patterns are ORed", () => {
    expect(subscribes(["domain.*", "message.bounced"], "message.bounced")).toBe(true)
    expect(subscribes(["domain.*", "message.bounced"], "message.received")).toBe(false)
  })
})

describe("the event catalogue", () => {
  test("recognises its own types", () => {
    for (const type of EVENT_TYPES) expect(isEventType(type)).toBe(true)
  })

  test("rejects anything else", () => {
    expect(isEventType("message.invented")).toBe(false)
    expect(isEventType("")).toBe(false)
  })

  test("every type is dotted family.action", () => {
    for (const type of EVENT_TYPES) expect(type).toMatch(/^[a-z]+\.[a-z_]+$/)
  })
})
