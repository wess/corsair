import { describe, expect, test } from "bun:test"
import { config } from "../src/config/index.ts"
import { checkOrigin, privateResponse } from "../src/httpguard/index.ts"

const origin = `${config.publicUrl.startsWith("https://") ? "https" : "http"}://webmail.example.com`
const request = (headers: Record<string, string>, method = "POST") =>
  new Request(`${origin}/api/mail/messages`, { method, headers })

describe("browser request boundaries", () => {
  test("accepts the page's own origin and non-browser API clients", () => {
    expect(checkOrigin(request({ origin, "sec-fetch-site": "same-origin" }))).toBeNull()
    expect(checkOrigin(request({}))).toBeNull()
  })

  test("refuses cross-site and sibling-domain mutations", () => {
    expect(checkOrigin(request({ origin: "https://attacker.test" }))?.status).toBe(403)
    expect(
      checkOrigin(request({ origin: "https://panel.example.com", "sec-fetch-site": "same-site" }))
        ?.status,
    ).toBe(403)
    expect(checkOrigin(request({ "sec-fetch-site": "cross-site" }))?.status).toBe(403)
    expect(checkOrigin(request({ origin: "null" }))?.status).toBe(403)
  })

  test("keeps discovery and reads accessible", () => {
    expect(checkOrigin(request({ origin: "https://other.test" }, "GET"))).toBeNull()
    expect(checkOrigin(request({ origin: "https://other.test" }, "OPTIONS"))).toBeNull()
  })

  test("private responses cannot be cached, including errors and downloads", async () => {
    for (const path of [
      "/api/mail/me",
      "/api/mail/messages/id/parts/1",
      "/jmap",
      "/.well-known/jmap",
    ]) {
      const response = privateResponse(
        new Request(`${origin}${path}`),
        new Response("private", {
          status: 401,
          headers: { "content-disposition": "attachment", "cache-control": "public" },
        }),
      )
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("content-disposition")).toBe("attachment")
      expect(response.status).toBe(401)
      expect(await response.text()).toBe("private")
    }
  })
})
