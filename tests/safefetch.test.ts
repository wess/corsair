import { describe, expect, test } from "bun:test"
import { assertPublicHost, isPublicAddress, safeFetch } from "../src/safefetch/index.ts"

/**
 * What a webhook URL may point at. No network: every host here is a literal or
 * is refused before a lookup.
 */

describe("isPublicAddress", () => {
  test("accepts ordinary public addresses", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "2606:4700:4700::1111",
      "[2001:4860::1]",
    ]) {
      expect(isPublicAddress(ip)).toBe(true)
    }
  })

  test("refuses private, loopback, link-local and reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // carrier-grade NAT
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicAddress(ip)).toBe(false)
    }
  })

  test("refuses IPv6 loopback, unspecified, unique-local and link-local", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "[::1]"]) {
      expect(isPublicAddress(ip)).toBe(false)
    }
  })

  test("sees through every way of spelling an IPv4 address inside IPv6", () => {
    for (const ip of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1", // the same address, in hex
      "[::ffff:169.254.169.254]",
      "::ffff:a00:1", // 10.0.0.1
      "64:ff9b::7f00:1", // NAT64 to loopback
      "::127.0.0.1", // IPv4-compatible
    ]) {
      expect(isPublicAddress(ip)).toBe(false)
    }
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true)
  })

  test("refuses what is not an address", () => {
    for (const ip of ["", "example.com", "1.2.3", "1.2.3.4.5", "999.1.1.1", "::g"]) {
      expect(isPublicAddress(ip)).toBe(false)
    }
  })
})

describe("safeFetch", () => {
  test("refuses a private literal before connecting", async () => {
    // `false` explicitly: the suite runs with WEBHOOK_ALLOW_PRIVATE on so the
    // webhook tests can use a local server.
    await expect(assertPublicHost("127.0.0.1", false)).rejects.toThrow(/private|loopback/)
    await expect(assertPublicHost("[::ffff:127.0.0.1]", false)).rejects.toThrow(/private|loopback/)
    await expect(assertPublicHost("localhost", false)).rejects.toThrow(/private|loopback/)
    await expect(assertPublicHost("api.localhost", false)).rejects.toThrow(/private|loopback/)
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/", {}, false)).rejects.toThrow()
  })

  test("does not follow a redirect to somewhere private", async () => {
    // A local server standing in for a public endpoint that redirects inward.
    // It is reached by literal 127.0.0.1, so the call passes the allow flag the
    // operator has for exactly that case, to get as far as the redirect.
    const target = Bun.serve({ port: 0, fetch: () => new Response("secret internal body") })
    const hop = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${target.port}/` },
        }),
    })
    try {
      const res = await safeFetch(`http://127.0.0.1:${hop.port}/`, {}, true)
      expect(res.status).toBe(302)
      expect(await res.text()).not.toContain("secret internal body")
    } finally {
      hop.stop(true)
      target.stop(true)
    }
  })
})
