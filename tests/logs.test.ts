import { describe, expect, test } from "bun:test"
import { clampLines, literal, read, redact, UNITS, unitFor } from "../src/logs/index.ts"

/**
 * The log reader, which is one careless line away from being a remote shell.
 *
 * It runs a subprocess on behalf of a web request, so the interesting tests are
 * not "does it return logs" but "what happens when the input is hostile". The
 * design answer is that there is no shell — `Bun.spawn` takes an argv array —
 * and that every value reaching journalctl is either written by this module or
 * escaped by it. These tests pin the second half.
 *
 * Needs no database. The `read` cases run against whatever journal this machine
 * has, and assert on shape rather than content.
 */

describe("which units may be asked for", () => {
  test("a known source resolves to its unit", () => {
    expect(unitFor("corsair")).toBe("corsair.service")
    expect(unitFor("mxfront")).toBe("corsair-mxfront.service")
  })

  test("anything else is refused", () => {
    // The whitelist is the control. Not a prefix check, not a pattern — if it
    // is not in the list there is no unit name to pass on.
    expect(() => unitFor("sshd")).toThrow(/Unknown log source/)
    expect(() => unitFor("../../etc/shadow")).toThrow(/Unknown log source/)
    expect(() => unitFor("corsair.service")).toThrow(/Unknown log source/)
    expect(() => unitFor("")).toThrow(/Unknown log source/)
  })

  test("every listed source names a real systemd unit", () => {
    for (const u of UNITS) expect(u.unit).toMatch(/^[a-z0-9@.-]+\.service$/)
  })
})

describe("the line count", () => {
  test("is clamped rather than trusted", () => {
    expect(clampLines(50)).toBe(50)
    // Unbounded output is a memory problem on a 1 GB box, not just a slow page.
    expect(clampLines(10_000_000)).toBe(2000)
    expect(clampLines(-1)).toBe(300)
    expect(clampLines("abc")).toBe(300)
    expect(clampLines(undefined)).toBe(300)
    expect(clampLines(Number.POSITIVE_INFINITY)).toBe(300)
  })
})

describe("the search term", () => {
  test("is escaped into a literal", () => {
    // --grep takes a regex. Unescaped, this reads far more than was typed.
    expect(literal(".*")).toBe("\\.\\*")
    expect(literal("a+b")).toBe("a\\+b")
    expect(literal("me@wess.io")).toBe("me@wess\\.io")
  })

  test("neutralises a pattern written to hang the process", () => {
    // Catastrophic backtracking in a subprocess this request is waiting on.
    const escaped = literal("(a+)+b")
    expect(escaped).toBe("\\(a\\+\\)\\+b")
    expect(escaped).not.toContain("(a+)+")
  })
})

describe("redaction on the way out", () => {
  test("removes a password from a connection string", () => {
    const line = "connect failed: postgresql://corsair:s3cr3t-pw@db.internal:5432/corsair"
    const out = redact(line)
    expect(out).not.toContain("s3cr3t-pw")
    expect(out).toContain("<redacted>")
    // Still useful afterwards — the host is the part being debugged.
    expect(out).toContain("db.internal")
  })

  test("removes credentials printed as key/value", () => {
    for (const line of [
      "env dump: PASSWORD=hunter2000",
      "header authorization: Bearer abc.def.ghi",
      "using api_key = live-9f8a7b",
      "token: eyJhbGciOiJIUzI1NiJ9",
    ]) {
      const out = redact(line)
      expect(out).toContain("<redacted>")
    }
    expect(redact("env dump: PASSWORD=hunter2000")).not.toContain("hunter2000")
  })

  test("removes provider secrets by their prefix", () => {
    expect(redact("signing with whsec_abc123XYZ")).not.toContain("abc123XYZ")
    expect(redact("charge via sk_live_9f8a7b6c")).not.toContain("9f8a7b6c")
  })

  test("leaves an ordinary line alone", () => {
    const line = "[corsair] delivered 1 message to someone@example.com in 42ms"
    expect(redact(line)).toBe(line)
  })
})

describe("reading", () => {
  test("an unknown source is refused before anything is spawned", async () => {
    await expect(read({ unit: "sshd" })).rejects.toThrow(/Unknown log source/)
  })

  test("returns a well-formed answer whatever the journal says", async () => {
    // On a machine with no journal, or no permission to read it, this must
    // report that rather than throw — the operator can act on the reason.
    const result = await read({ unit: "corsair", lines: 5, since: "15m" })
    expect(Array.isArray(result.entries)).toBe(true)
    expect(typeof result.available).toBe("boolean")
    if (!result.available) expect(typeof result.reason).toBe("string")
    for (const entry of result.entries) {
      expect(typeof entry.message).toBe("string")
      expect(Number.isFinite(entry.priority)).toBe(true)
      expect(new Date(entry.at).toString()).not.toBe("Invalid Date")
    }
  })
})
