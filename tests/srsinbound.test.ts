import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { resolveRecipient } from "../src/addresses/index.ts"
import { db } from "../src/db/index.ts"
import { rewrite } from "../src/smtp/srs/index.ts"

/**
 * A bounce for forwarded mail comes back to the SRS address this server rewrote
 * the sender into. It has to find its way home — and only a bounce this server
 * really generated may, or the rewritten form is an open relay.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `srs-${suffix}.invalid`
let userId = ""

beforeAll(async () => {
  userId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Srs', $2) RETURNING id`,
    values: [`srs-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id
  await db().execute({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=srs', 'active')`,
    values: [userId, zone],
  })
})

afterAll(async () => {
  await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [userId] })
})

describe("a bounce to an SRS address", () => {
  test("is routed to the original sender", async () => {
    const rewritten = rewrite("Sam.Sender@far.invalid", zone)
    const route = await resolveRecipient(rewritten)
    expect(route.kind).toBe("forward")
    if (route.kind === "forward") {
      // The original's own spelling survives; only the case of our own domain is
      // folded by the lookup.
      expect(route.destinations).toEqual(["Sam.Sender@far.invalid"])
    }
  })

  test("is refused when its signature is wrong", async () => {
    const rewritten = rewrite("sam@far.invalid", zone)
    const tampered = rewritten.replace(/^SRS0=[^=]+=/, "SRS0=AAAA=")
    expect((await resolveRecipient(tampered)).kind).toBe("unknown")
  })

  test("cannot be re-aimed at a different original sender", async () => {
    const rewritten = rewrite("sam@far.invalid", zone)
    const aimed = rewritten.replace("far.invalid=sam", "victim.invalid=someone")
    expect((await resolveRecipient(aimed)).kind).toBe("unknown")
  })

  test("is refused once it is older than the window", async () => {
    // A stamp 30 days in the past, signed by us: genuine, but expired.
    const realNow = Date.now
    try {
      Date.now = () => realNow() - 30 * 86_400_000
      const old = rewrite("sam@far.invalid", zone)
      Date.now = realNow
      expect((await resolveRecipient(old)).kind).toBe("unknown")
    } finally {
      Date.now = realNow
    }
  })

  test("to a domain we do not host is not ours to route", async () => {
    expect((await resolveRecipient("SRS0=abcd=AB=far.invalid=sam@elsewhere.invalid")).kind).toBe(
      "unknown",
    )
  })
})
