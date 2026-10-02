import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { token } from "@atlas/auth"
import { createAddress, setPassword } from "../src/addresses/index.ts"
import { buildFetch } from "../src/api/index.ts"
import { revokeAllSessions } from "../src/auth/index.ts"
import { config } from "../src/config/index.ts"
import { db } from "../src/db/index.ts"

/**
 * Webmail sessions are rows on the server, not just a signed token.
 *
 * What this buys, and what each test pins: logging out revokes the session
 * instead of clearing a cookie the attacker also has; a token signed with the
 * real secret but naming no live session is worthless; changing the password
 * ends the other sessions.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `sess-${suffix}.invalid`
const password = "correct horse battery staple"
const app = buildFetch(null)

let userId = ""
let addressId = ""

const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
  const { cookie, ...rest } = init
  return app(
    new Request(`http://corsair.test${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...rest.headers,
      },
    }),
  )
}

const login = async (pass = password): Promise<string> => {
  // The login route allows five a second per address, and means it.
  await Bun.sleep(300)
  const res = await call("/api/mail/login", {
    method: "POST",
    body: JSON.stringify({ email: `box@${zone}`, password: pass }),
  })
  expect(res.status).toBe(200)
  const cookie = res.headers.get("set-cookie") ?? ""
  return cookie.split(";")[0]!
}

const status = async (cookie: string) => (await call("/api/mail/me", { cookie })).status

beforeAll(async () => {
  userId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Sess', $2) RETURNING id`,
    values: [`sess-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id
  const domain = (await db().one<{ id: string }>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=sess', 'active') RETURNING id`,
    values: [userId, zone],
  }))!
  const { address } = await createAddress({
    domainId: domain.id,
    localPart: "box",
    type: "standard",
    password,
  })
  addressId = address.id
})

afterAll(async () => {
  await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [userId] })
})

describe("a webmail session", () => {
  test("works, and has a row naming it", async () => {
    const cookie = await login()
    expect(await status(cookie)).toBe(200)
    const row = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM mail_sessions WHERE address_id = $1 AND revoked_at IS NULL",
      values: [addressId],
    })
    expect(Number(row?.count)).toBeGreaterThan(0)
  })

  test("logging out revokes it on the server, so a copied cookie is dead too", async () => {
    const cookie = await login()
    expect(await status(cookie)).toBe(200)
    await call("/api/mail/logout", { method: "POST", cookie })
    // The same cookie, replayed: it is still a validly signed, unexpired token.
    expect(await status(cookie)).toBe(401)
  })

  test("a token signed with the real secret but naming no session is refused", async () => {
    const forged = await token.sign(
      { sub: addressId, kind: "mailbox", jti: crypto.randomUUID() },
      config.jwtSecret,
      { expiresIn: 3600 },
    )
    expect(await status(`corsair_webmail=${encodeURIComponent(forged)}`)).toBe(401)
  })

  test("a token with no session id at all is refused — the old kind", async () => {
    const old = await token.sign({ sub: addressId, kind: "mailbox" }, config.jwtSecret, {
      expiresIn: 3600,
    })
    expect(await status(`corsair_webmail=${encodeURIComponent(old)}`)).toBe(401)
  })

  test("a session cannot be moved to another address", async () => {
    // A real session id, but a `sub` that is somebody else's: the row names one
    // address and the token another.
    const real = await db().one<{ id: string }>({
      text: "SELECT id FROM mail_sessions WHERE address_id = $1 AND revoked_at IS NULL LIMIT 1",
      values: [addressId],
    })
    const other = await token.sign(
      { sub: crypto.randomUUID(), kind: "mailbox", jti: real!.id },
      config.jwtSecret,
      { expiresIn: 3600 },
    )
    expect(await status(`corsair_webmail=${encodeURIComponent(other)}`)).toBe(401)
  })

  test("an expired session row is refused even with an unexpired token", async () => {
    const cookie = await login()
    await db().execute({
      text: "UPDATE mail_sessions SET expires_at = now() - interval '1 minute' WHERE address_id = $1",
      values: [addressId],
    })
    expect(await status(cookie)).toBe(401)
  })
})

describe("ending sessions", () => {
  test("changing the password keeps this session and ends the others", async () => {
    const mine = await login()
    const elsewhere = await login()
    expect(await status(elsewhere)).toBe(200)

    const changed = await call("/api/mail/password", {
      method: "POST",
      cookie: mine,
      body: JSON.stringify({ current_password: password, new_password: `${password} two` }),
    })
    expect(changed.status).toBe(200)

    expect(await status(mine)).toBe(200)
    expect(await status(elsewhere)).toBe(401)

    // Put it back for the tests that follow.
    await setPassword(addressId, password)
  })

  test("an administrator setting the password ends every session", async () => {
    const cookie = await login()
    expect(await status(cookie)).toBe(200)
    await setPassword(addressId, `${password} three`)
    expect(await status(cookie)).toBe(401)
    await setPassword(addressId, password)
  })

  test("changing the account password ends a linked mailbox's sessions", async () => {
    const cookie = await login()
    expect(await status(cookie)).toBe(200)
    await db().execute({
      text: "UPDATE addresses SET user_id = $2 WHERE id = $1",
      values: [addressId, userId],
    })
    await revokeAllSessions(userId)
    expect(await status(cookie)).toBe(401)
    await db().execute({
      text: "UPDATE addresses SET user_id = NULL WHERE id = $1",
      values: [addressId],
    })
  })

  test("deleting the address takes its sessions with it", async () => {
    const { address } = await createAddress({
      domainId: (await db().one<{ domain_id: string }>({
        text: "SELECT domain_id FROM addresses WHERE id = $1",
        values: [addressId],
      }))!.domain_id,
      localPart: "gone",
      type: "standard",
      password,
    })
    await db().execute({
      text: "INSERT INTO mail_sessions (id, address_id, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      values: [crypto.randomUUID(), address.id],
    })
    await db().execute({ text: "DELETE FROM addresses WHERE id = $1", values: [address.id] })
    const left = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM mail_sessions WHERE address_id = $1",
      values: [address.id],
    })
    expect(Number(left?.count)).toBe(0)
  })
})
