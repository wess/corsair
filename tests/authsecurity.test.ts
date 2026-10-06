import { afterAll, beforeAll, expect, test } from "bun:test"
import { token } from "@atlas/auth"
import { createHash } from "node:crypto"
import { buildFetch } from "../src/api/index.ts"
import { hashPassword, issueSession, resolveSession, SESSION_COOKIE } from "../src/auth/index.ts"
import { db } from "../src/db/index.ts"
import { secretFor } from "../src/secrets/index.ts"

const app = buildFetch(null)
const email = `authsecurity-${crypto.randomUUID()}@example.invalid`
const password = "security-test-password-9182"
const code = "12345678"
let userId = ""

beforeAll(async () => {
  const row = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code, totp_enabled, backup_codes)
           VALUES ($1, $2, 'Security', $3, true, $4) RETURNING id`,
    values: [
      email,
      await hashPassword(password),
      crypto.randomUUID(),
      [createHash("sha256").update(code).digest("hex")],
    ],
  })
  userId = row!.id
})

afterAll(async () => {
  await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [userId] })
})

test("two simultaneous logins cannot redeem the same backup code", async () => {
  const login = () =>
    app(
      new Request("http://corsair.test/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, code }),
      }),
    )
  const responses = await Promise.all([login(), login()])
  expect(responses.map((res) => res.status).sort()).toEqual([200, 401])
})

test("a session row cannot be used with another token subject", async () => {
  const { token: signed } = await issueSession(userId)
  const claims = (await token.verify(signed, secretFor("session"))) as Record<string, unknown>
  const wrong = await token.sign({ ...claims, sub: crypto.randomUUID() }, secretFor("session"), {
    expiresIn: 60,
  })
  expect(await resolveSession(`${SESSION_COOKIE}=${wrong}`)).toBeNull()
  expect((await resolveSession(`${SESSION_COOKIE}=${signed}`))?.userId).toBe(userId)
})

test("password work rejects excess requests instead of growing an unlimited queue", async () => {
  const results = await Promise.allSettled(Array.from({ length: 40 }, () => hashPassword(password)))
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(36)
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(4)
})
