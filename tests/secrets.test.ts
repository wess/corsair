import { describe, expect, test } from "bun:test"
import { assertSecret, secretProblem } from "../src/secrets/index.ts"

describe("the signing secret", () => {
  test("refuses the values shipped in the repository", () => {
    expect(secretProblem("corsair-dev-secret-change-me")).not.toBeNull()
    expect(secretProblem("change-me-to-a-long-random-string")).not.toBeNull()
    // A padded copy of a shipped value is still the shipped value.
    expect(secretProblem(`${"x".repeat(40)}change-me`)).not.toBeNull()
  })

  test("refuses one that is too short to be random", () => {
    expect(secretProblem("hunter2")).not.toBeNull()
    expect(secretProblem("a".repeat(31))).not.toBeNull()
  })

  test("accepts a generated one", () => {
    expect(
      secretProblem(Buffer.from(crypto.getRandomValues(new Uint8Array(48))).toString("base64")),
    ).toBeNull()
    expect(() => assertSecret("a".repeat(32))).not.toThrow()
    expect(() => assertSecret("short")).toThrow(/openssl rand/)
  })
})

import { createCipheriv, createHash, createHmac, randomBytes } from "node:crypto"
import { token } from "@atlas/auth"
import { config } from "../src/config/index.ts"
import { decryptSecret, encryptSecret, keyFor, secretFor } from "../src/secrets/index.ts"
import { reverse, rewrite } from "../src/smtp/srs/index.ts"

describe("per-purpose keys", () => {
  test("each purpose has its own key, and they are not the secret", () => {
    const purposes = ["session", "mailsession", "srs", "transfer"] as const
    const keys = purposes.map((p) => keyFor(p).toString("hex"))
    expect(new Set(keys).size).toBe(purposes.length)
    for (const key of keys) {
      expect(key).not.toBe(Buffer.from(config.jwtSecret).toString("hex"))
      expect(key).toHaveLength(64)
    }
  })

  test("are stable for one secret and different for another", () => {
    expect(keyFor("srs", "a".repeat(40)).equals(keyFor("srs", "a".repeat(40)))).toBe(true)
    expect(keyFor("srs", "a".repeat(40)).equals(keyFor("srs", "b".repeat(40)))).toBe(false)
  })

  test("a token for one purpose is not valid for another, or under the raw secret", async () => {
    const signed = await token.sign({ sub: "x" }, secretFor("session"), { expiresIn: 60 })
    await expect(token.verify(signed, secretFor("session"))).resolves.toBeDefined()
    await expect(token.verify(signed, secretFor("mailsession"))).rejects.toThrow()
    await expect(token.verify(signed, config.jwtSecret)).rejects.toThrow()
    // And the reverse: a token minted from the bare secret — what a leak of it
    // used to allow — is no good for a session.
    const forged = await token.sign({ sub: "x" }, config.jwtSecret, { expiresIn: 60 })
    await expect(token.verify(forged, secretFor("session"))).rejects.toThrow()
  })
})

describe("stored credentials", () => {
  test("round-trip under the transfer key", () => {
    expect(decryptSecret(encryptSecret("hunter2 é"))).toBe("hunter2 é")
  })

  test("one encrypted before per-purpose keys still opens", () => {
    // How a transfer started on the previous release stored its password.
    const iv = randomBytes(12)
    const cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256").update(config.jwtSecret).digest(),
      iv,
    )
    const payload = cipher.update("legacy password", "utf8", "base64") + cipher.final("base64")
    const stored = `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${payload}`
    expect(decryptSecret(stored)).toBe("legacy password")
  })

  test("a tampered one is refused rather than decrypted to garbage", () => {
    const stored = encryptSecret("secret")
    const [iv, tag, body] = stored.split(":")
    expect(() =>
      decryptSecret(`${iv}:${tag}:${Buffer.from("AAAA", "utf8").toString("base64")}${body}`),
    ).toThrow()
  })
})

describe("SRS under its own key", () => {
  test("a rewritten address reverses", () => {
    const rewritten = rewrite("sam@far.invalid", "fwd.example")
    expect(reverse(rewritten)).toEqual({ ok: true, address: "sam@far.invalid" })
  })

  test("one signed with the bare secret, as before, still reverses inside the window", () => {
    const stamp = rewrite("sam@far.invalid", "fwd.example").split("=")[2]!
    const payload = `${stamp}=far.invalid=sam`
    const hash = createHmac("sha256", config.jwtSecret)
      .update(payload.toLowerCase())
      .digest("base64")
      .replace(/[^A-Za-z0-9]/g, "")
      .slice(0, 4)
    expect(reverse(`SRS0=${hash}=${payload}@fwd.example`)).toEqual({
      ok: true,
      address: "sam@far.invalid",
    })
  })
})
