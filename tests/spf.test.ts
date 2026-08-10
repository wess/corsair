import { describe, expect, test } from "bun:test"
import { ipInCidr, spfAligned } from "../src/spf/index.ts"

describe("ipInCidr — IPv4", () => {
  test("matches inside the prefix and rejects outside", () => {
    expect(ipInCidr("192.0.2.10", "192.0.2.0", 24)).toBe(true)
    expect(ipInCidr("192.0.3.10", "192.0.2.0", 24)).toBe(false)
  })

  test("a /32 is an exact address", () => {
    expect(ipInCidr("192.0.2.10", "192.0.2.10", 32)).toBe(true)
    expect(ipInCidr("192.0.2.11", "192.0.2.10", 32)).toBe(false)
  })

  test("a /0 matches everything", () => {
    expect(ipInCidr("8.8.8.8", "0.0.0.0", 0)).toBe(true)
  })

  test("handles the high bit without sign trouble", () => {
    // 255.x masked with a shift is where a signed 32-bit bug shows up.
    expect(ipInCidr("255.255.255.1", "255.255.255.0", 24)).toBe(true)
    expect(ipInCidr("128.0.0.1", "128.0.0.0", 8)).toBe(true)
    expect(ipInCidr("127.0.0.1", "128.0.0.0", 8)).toBe(false)
  })

  test("rejects malformed input rather than guessing", () => {
    expect(ipInCidr("192.0.2", "192.0.2.0", 24)).toBe(false)
    expect(ipInCidr("192.0.2.999", "192.0.2.0", 24)).toBe(false)
  })
})

describe("ipInCidr — IPv6", () => {
  test("expands :: and matches a prefix", () => {
    expect(ipInCidr("2001:db8::1", "2001:db8::", 32)).toBe(true)
    expect(ipInCidr("2001:db9::1", "2001:db8::", 32)).toBe(false)
  })

  test("a /128 is an exact address", () => {
    expect(ipInCidr("2001:db8::1", "2001:db8::1", 128)).toBe(true)
    expect(ipInCidr("2001:db8::2", "2001:db8::1", 128)).toBe(false)
  })

  test("handles a fully written address", () => {
    expect(ipInCidr("2001:0db8:0000:0000:0000:0000:0000:0001", "2001:db8::", 32)).toBe(true)
  })

  test("handles an embedded IPv4 tail", () => {
    expect(ipInCidr("::ffff:192.0.2.1", "::ffff:192.0.2.0", 120)).toBe(true)
  })

  test("does not match an IPv4 address against an IPv6 network", () => {
    expect(ipInCidr("192.0.2.1", "2001:db8::", 32)).toBe(false)
  })
})

describe("alignment", () => {
  test("relaxed accepts an organisational-domain match", () => {
    expect(spfAligned("mail.wess.io", "wess.io")).toBe(true)
    expect(spfAligned("wess.io", "wess.io")).toBe(true)
  })

  test("strict requires an exact match", () => {
    expect(spfAligned("mail.wess.io", "wess.io", "strict")).toBe(false)
    expect(spfAligned("wess.io", "wess.io", "strict")).toBe(true)
  })

  test("an unrelated domain never aligns", () => {
    expect(spfAligned("evil.com", "wess.io")).toBe(false)
  })
})
