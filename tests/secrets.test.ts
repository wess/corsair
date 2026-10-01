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
