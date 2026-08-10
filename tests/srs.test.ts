import { describe, expect, test } from "bun:test"
import { isRewritten, reverse, rewrite } from "../src/smtp/srs/index.ts"

describe("rewrite", () => {
  test("moves the envelope sender into the forwarding domain", () => {
    const rewritten = rewrite("me@sender.com", "wess.io")
    expect(rewritten).toEndWith("@wess.io")
    expect(rewritten).toStartWith("SRS0=")
    expect(rewritten).toContain("sender.com")
    expect(isRewritten(rewritten)).toBe(true)
  })

  test("round-trips back to the original", () => {
    const rewritten = rewrite("me@sender.com", "wess.io")
    expect(reverse(rewritten)).toEqual({ ok: true, address: "me@sender.com" })
  })

  test("preserves a local part containing dots and plus tags", () => {
    const rewritten = rewrite("first.last+tag@sender.com", "wess.io")
    expect(reverse(rewritten)).toEqual({ ok: true, address: "first.last+tag@sender.com" })
  })

  test("leaves the null sender alone so bounces stay bounces", () => {
    expect(rewrite("", "wess.io")).toBe("")
  })

  test("does not nest an already-rewritten address", () => {
    const once = rewrite("me@sender.com", "wess.io")
    const twice = rewrite(once, "other.example")
    expect(twice).toEndWith("@other.example")
    expect(twice.split("SRS0=").length - 1).toBe(1)
  })
})

describe("reverse", () => {
  test("refuses a forged signature", () => {
    const rewritten = rewrite("me@sender.com", "wess.io")
    // Swap the payload domain but keep the hash: this is the open-relay attack.
    const forged = rewritten.replace("sender.com", "attacker.com")
    expect(reverse(forged)).toEqual({ ok: false, reason: "bad_signature" })
  })

  test("refuses a hand-made address that never came from us", () => {
    expect(reverse("SRS0=aaaa=AB=victim.com=target@wess.io")).toEqual({
      ok: false,
      reason: "bad_signature",
    })
  })

  test("reports a plain address as not-SRS rather than failing", () => {
    expect(reverse("me@wess.io")).toEqual({ ok: false, reason: "not_srs" })
  })

  test("tolerates a local part lower-cased in transit", () => {
    const rewritten = rewrite("Me@Sender.com", "wess.io")
    const at = rewritten.lastIndexOf("@")
    const mangled = `${rewritten.slice(0, at).toLowerCase()}${rewritten.slice(at)}`
    const result = reverse(mangled)
    expect(result.ok).toBe(true)
  })
})
