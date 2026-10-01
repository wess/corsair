import { describe, expect, test } from "bun:test"
import { createImapSession } from "../src/imap/session/index.ts"

/**
 * What an unauthenticated IMAP connection may make the server buffer. No
 * database: every case is refused before a command is dispatched.
 *
 * It matters because the buffer is attacker-controlled memory on a small box.
 * Chained literals once let one socket hold 550 MB without a byte coming back.
 */

const session = () =>
  createImapSession({ isSecure: () => true, remoteIp: "203.0.113.5", push: () => {} })

describe("an unauthenticated connection", () => {
  test("is cut off at an oversized line", async () => {
    const s = session()
    const out = await s.feed("a".repeat(9_000))
    expect(out).toContain("BYE")
    expect(s.shouldClose()).toBe(true)
  })

  test("is cut off at an oversized literal, even a LITERAL+ one", async () => {
    const s = session()
    const out = await s.feed("a1 LOGIN {9000+}\r\n")
    expect(out).toContain("BYE")
    expect(s.shouldClose()).toBe(true)
  })

  test("cannot chain small literals past the cap", async () => {
    const s = session()
    // Each is under the cap on its own; together they are not.
    const first = await s.feed(`a1 NOOP {5000+}\r\n${"x".repeat(5_000)}`)
    expect(first).not.toContain("BYE")
    const second = await s.feed("{5000+}\r\n")
    expect(second).toContain("BYE")
    expect(s.shouldClose()).toBe(true)
  })

  test("still accepts an ordinary command", async () => {
    const s = session()
    const out = await s.feed("a1 NOOP\r\n")
    expect(out).toContain("a1 OK")
    expect(s.shouldClose()).toBe(false)
  })
})
