import { describe, expect, test } from "bun:test"
import { spfExempt } from "../src/smtp/inbound/index.ts"
import { createSession, type SessionHooks } from "../src/smtp/session/index.ts"

/**
 * XCLIENT, and the trust boundary it depends on.
 *
 * Bun cannot upgrade an accepted socket to TLS, so a terminator written in Rust
 * holds ports 25 and 587 and relays to loopback listeners. That moves one fact
 * off the socket and onto the wire: the client's address now arrives as a
 * *claim*, and a claim is only worth the check in front of it.
 *
 * Two rules carry the whole thing:
 *
 *   - XCLIENT is refused unless the peer is a configured trusted proxy, decided
 *     by the listener from the socket. Accepting it from anyone would let any
 *     sender assert any address and walk past SPF, the bans, and the limits.
 *   - The "this is us" shortcut that skips SPF for loopback now requires the
 *     listener to confirm the session arrived *directly*. Behind a proxy every
 *     session comes from 127.0.0.1, and the address alone would exempt the
 *     internet.
 *
 * Needs no database or network.
 */

type Proxied = { addr: string | null; secure: boolean }

const harness = (over: Partial<SessionHooks> = {}) => {
  const seen: Proxied[] = []
  let secure = false

  const hooks: SessionHooks = {
    mode: "mx",
    hostname: "mx1.test",
    maxSize: 1024,
    remoteIp: "127.0.0.1",
    isSecure: () => secure,
    onProxy: (info) => {
      seen.push(info)
      if (info.secure) secure = true
    },
    validateSender: async () => null,
    validateRecipient: async () => null,
    handleMessage: async () => ({ code: 250, enhanced: "2.0.0", message: "Queued." }),
    ...over,
  }

  const session = createSession(hooks)
  return {
    session,
    seen,
    isSecure: () => secure,
    send: (...lines: string[]) => session.feed(`${lines.join("\r\n")}\r\n`),
  }
}

describe("who may speak XCLIENT", () => {
  test("an untrusted peer is refused", async () => {
    const h = harness({ trustProxy: false })
    const out = await h.send("XCLIENT ADDR=203.0.113.9")

    expect(out).toStartWith("550 ")
    // Nothing was believed: the listener never hears about it.
    expect(h.seen).toHaveLength(0)
  })

  test("the default is untrusted", async () => {
    // `trustProxy` unset must not mean "sure". A listener that forgets to pass
    // it is the likeliest way this becomes exploitable.
    const h = harness()
    expect(await h.send("XCLIENT ADDR=203.0.113.9")).toStartWith("550 ")
    expect(h.seen).toHaveLength(0)
  })

  test("a trusted proxy is believed and the session restarts", async () => {
    const h = harness({ trustProxy: true })
    const out = await h.send("XCLIENT ADDR=203.0.113.9 PROTO=SMTP")

    expect(out).toStartWith("220 ")
    expect(h.seen).toEqual([{ addr: "203.0.113.9", secure: false }])
  })
})

describe("what XCLIENT is allowed to say", () => {
  test("ESMTPS makes the session encrypted, so AUTH can be offered", async () => {
    const h = harness({ trustProxy: true, mode: "submission", authenticate: async () => null })
    expect(h.isSecure()).toBe(false)

    await h.send("XCLIENT PROTO=ESMTPS")
    expect(h.isSecure()).toBe(true)

    // The point of saying so: submission refuses to authenticate in the clear,
    // and the terminator has already done the encrypting.
    const ehlo = await h.send("EHLO client.test")
    expect(ehlo).toContain("250-AUTH")
  })

  test("a malformed address is rejected rather than stored", async () => {
    const h = harness({ trustProxy: true })
    expect(await h.send("XCLIENT ADDR=not an address")).toStartWith("501 ")
    expect(await h.send("XCLIENT ADDR=<script>")).toStartWith("501 ")
    expect(h.seen).toHaveLength(0)
  })

  test("[UNAVAILABLE] does not become a literal address", async () => {
    // The specified way for a proxy to say it does not know. Storing the string
    // would put "[UNAVAILABLE]" into SPF lookups and Received headers.
    const h = harness({ trustProxy: true })
    await h.send("XCLIENT ADDR=[UNAVAILABLE] PROTO=SMTP")
    expect(h.seen).toEqual([{ addr: null, secure: false }])
  })

  test("attributes without an equals sign are a syntax error", async () => {
    const h = harness({ trustProxy: true })
    expect(await h.send("XCLIENT NONSENSE")).toStartWith("501 ")
  })

  test("it discards everything the previous session negotiated", async () => {
    const h = harness({ trustProxy: true })
    await h.send("EHLO before.test")
    await h.send("XCLIENT ADDR=203.0.113.9")

    // MAIL without a fresh EHLO must be refused: the greeting belonged to the
    // proxy's connection, not to the client now on the other end of it.
    expect(await h.send("MAIL FROM:<someone@example.test>")).toStartWith("503 ")
  })
})

describe("the loopback SPF shortcut", () => {
  test("applies to a session this machine opened to itself", () => {
    expect(spfExempt({ remoteIp: "127.0.0.1", local: true })).toBe(true)
    expect(spfExempt({ remoteIp: "::1", local: true })).toBe(true)
  })

  test("never applies to a relayed session", () => {
    // The failure this prevents: with a terminator in front, every message on
    // earth arrives from 127.0.0.1. Exempting on the address alone would mean
    // every forgery passes SPF.
    expect(spfExempt({ remoteIp: "127.0.0.1", local: false })).toBe(false)
    expect(spfExempt({ remoteIp: "127.0.0.1" })).toBe(false)
  })

  test("never applies to a real remote address", () => {
    expect(spfExempt({ remoteIp: "203.0.113.9", local: true })).toBe(false)
  })
})
