import { describe, expect, test } from "bun:test"
import { assertNoSelfLoop } from "../src/addresses/index.ts"
import { handleMessage, mayBounceTo } from "../src/smtp/inbound/index.ts"
import type { Envelope } from "../src/smtp/session/index.ts"

/**
 * Mail loops. No database: both are refused before anything is looked up.
 */

const envelope: Envelope = {
  helo: "far.invalid",
  mailFrom: "someone@far.invalid",
  hasSender: true,
  rcptTo: ["user@example.invalid"],
  size: null,
  smtputf8: false,
}

const ctx = { remoteIp: "203.0.113.9", helo: "far.invalid" } as never

const withHops = (n: number) =>
  [
    ...Array.from(
      { length: n },
      (_, i) => `Received: from hop${i}.invalid by mx.invalid; Mon, 1 Jan 2026 00:00:00 +0000`,
    ),
    "From: someone@far.invalid",
    "To: user@example.invalid",
    "Subject: loop",
    "",
    "body",
    "",
  ].join("\r\n")

describe("hop count", () => {
  test("a message through too many hops is refused as a loop", async () => {
    const reply = await handleMessage(envelope, withHops(31), ctx)
    expect(reply.code).toBe(554)
    expect(JSON.stringify(reply)).toContain("5.4.6")
  })

  test("the body of a message is not counted", async () => {
    // Forty "Received:" lines in the *body* are quoted text, not hops. The first
    // check that decides is the header block; this reaches the next stage (which
    // needs a database) rather than being refused as a loop.
    const raw = `${withHops(2)}${Array.from({ length: 40 }, () => "Received: quoted").join("\r\n")}\r\n`
    const attempt = handleMessage(envelope, raw, ctx)
    const reply = await attempt.catch(() => null)
    expect(reply === null || reply.code !== 554).toBe(true)
  })
})

describe("an alias that forwards to itself", () => {
  test("is refused, whatever the case or spacing", () => {
    expect(() => assertNoSelfLoop("sales", "example.com", ["Sales@Example.com "])).toThrow(/itself/)
    expect(() =>
      assertNoSelfLoop("sales", "example.com", ["x@y.test", "sales@example.com"]),
    ).toThrow()
  })

  test("is allowed to forward anywhere else, including its own domain", () => {
    expect(() => assertNoSelfLoop("sales", "example.com", ["boss@example.com"])).not.toThrow()
    expect(() => assertNoSelfLoop("sales", "example.com", ["sales@other.test"])).not.toThrow()
  })
})

describe("who may be bounced to", () => {
  test("a sender whose SPF passed, or whose DKIM verified", () => {
    expect(mayBounceTo({ spf: "pass", dkim: "none" })).toBe(true)
    expect(mayBounceTo({ spf: "fail", dkim: "pass" })).toBe(true)
  })

  test("not a sender nothing vouches for — that is backscatter to a forged address", () => {
    for (const spf of ["fail", "softfail", "neutral", "none", "temperror", "permerror"]) {
      expect(mayBounceTo({ spf, dkim: "none" })).toBe(false)
    }
    expect(mayBounceTo({ spf: "none", dkim: "fail" })).toBe(false)
  })
})
