import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@wess/atlas/db/query"
import { createAddress, setPassword } from "../src/addresses/index.ts"
import { createAgent } from "../src/agents/index.ts"
import { buildFetch } from "../src/api/index.ts"
import {
  createAppPassword,
  deleteAppPassword,
  generateAppPassword,
  normalizeAppPassword,
} from "../src/apppasswords/index.ts"
import {
  authenticateAddress,
  hashPassword,
  issueMailSession,
  issueSession,
  MAIL_COOKIE,
  SESSION_COOKIE,
} from "../src/auth/index.ts"
import { db } from "../src/db/index.ts"
import { createImapSession } from "../src/imap/session/index.ts"
import { createPop3Session } from "../src/pop3/session/index.ts"
import { type Address, addresses, type Domain, users } from "../src/schema/index.ts"
import { appPasswordObject } from "../src/serialize/index.ts"
import { createSession } from "../src/smtp/session/index.ts"
import { authenticate } from "../src/smtp/submission/index.ts"

/**
 * App passwords: per-client credentials accepted by every mail protocol and by
 * nothing else.
 *
 * The protocol tests drive real IMAP, POP3 and SMTP sessions, because the thing
 * that matters is that each listener reaches `authenticateResolved` with its own
 * name — a listener that passed none would fail the scope tests here.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `apppw-${suffix}.invalid`

const ACCOUNT_PASSWORD = "account-password-4412"
const MAILBOX_PASSWORD = "mailbox-password-9917"

let ownerId = ""
let domain: Domain
let family: Address
let linked: Address

const reload = async (id: string): Promise<Address> =>
  (await db().one<Address>(from(addresses).where((q) => q("id").equals(id))))!

const setRequire = async (id: string, value: boolean) =>
  db().execute(
    from(addresses)
      .where((q) => q("id").equals(id))
      .update({ require_app_passwords: value }),
  )

const imapLogin = async (email: string, password: string): Promise<string> => {
  const session = createImapSession({
    isSecure: () => true,
    remoteIp: "203.0.113.40",
    push: () => {},
  })
  return session.feed(`a1 LOGIN "${email}" "${password}"\r\n`)
}

const smtpAuth = async (email: string, password: string): Promise<string> => {
  const session = createSession({
    mode: "submission",
    hostname: "mx.test",
    maxSize: 1024,
    remoteIp: "203.0.113.40",
    isSecure: () => true,
    authenticate: (username, pass) => authenticate(username, pass, "203.0.113.40"),
    validateSender: async () => null,
    validateRecipient: async () => null,
    handleMessage: async () => ({ code: 250, enhanced: "2.0.0", message: "Queued." }),
  })
  await session.feed("EHLO client.test\r\n")
  const payload = Buffer.from(`\0${email}\0${password}`).toString("base64")
  return session.feed(`AUTH PLAIN ${payload}\r\n`)
}

beforeAll(async () => {
  ownerId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code, totp_enabled)
           VALUES ($1, $2, 'AppPw', $3, true) RETURNING id`,
    values: [`owner@${zone}`, await hashPassword(ACCOUNT_PASSWORD), `ap${suffix}`],
  }))!.id

  domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=apppw', 'active') RETURNING *`,
    values: [ownerId, zone],
  }))!

  family = (
    await createAddress({
      domainId: domain.id,
      localPart: "family",
      type: "standard",
      password: MAILBOX_PASSWORD,
    })
  ).address
  linked = (await createAddress({ domainId: domain.id, localPart: "owner", type: "standard" }))
    .address
  expect(linked.user_id).toBe(ownerId)
})

afterAll(async () => {
  await db().execute(
    from(users)
      .where((q) => q("id").equals(ownerId))
      .del(),
  )
})

describe("the secret", () => {
  test("is five groups of four from an unambiguous alphabet", () => {
    const secret = generateAppPassword()
    expect(secret).toMatch(/^[a-kmnp-z2-9]{4}(-[a-kmnp-z2-9]{4}){4}$/)
    expect(new Set(Array.from({ length: 50 }, generateAppPassword)).size).toBe(50)
  })

  test("is accepted however a phone keyboard mangles it", () => {
    const secret = generateAppPassword()
    const canonical = secret.replace(/-/g, "")
    expect(normalizeAppPassword(secret)).toBe(canonical)
    expect(normalizeAppPassword(secret.toUpperCase())).toBe(canonical)
    expect(normalizeAppPassword(secret.replace(/-/g, " "))).toBe(canonical)
    expect(normalizeAppPassword("hunter2hunter2")).toBeNull()
  })
})

describe("signing in with an app password", () => {
  test("opens IMAP, POP3 and SMTP submission", async () => {
    const { password } = await createAppPassword({ address: family, name: "Phone" })
    const email = `family@${zone}`

    expect(await imapLogin(email, password)).toContain("a1 OK")
    expect(await smtpAuth(email, password)).toStartWith("235 ")

    const pop = createPop3Session({ isSecure: () => true, remoteIp: "203.0.113.40" })
    await pop.feed(`USER ${email}\r\n`)
    expect(await pop.feed(`PASS ${password}\r\n`)).toStartWith("+OK")
  })

  test("works typed without the dashes and with a capital", async () => {
    const { password } = await createAppPassword({ address: family, name: "Tablet" })
    const typed = password.replace(/-/g, "")
    expect(await imapLogin(`family@${zone}`, typed[0]!.toUpperCase() + typed.slice(1))).toContain(
      "a1 OK",
    )
  })

  test("records when and from where it was used", async () => {
    const { appPassword, password } = await createAppPassword({ address: family, name: "Laptop" })
    await imapLogin(`family@${zone}`, password)
    await Bun.sleep(50)
    const row = await db().one<{ last_used_at: Date | null; last_used_ip: string | null }>({
      text: "SELECT last_used_at, last_used_ip FROM app_passwords WHERE id = $1",
      values: [appPassword.id],
    })
    expect(row?.last_used_at).not.toBeNull()
    expect(row?.last_used_ip).toBe("203.0.113.40")
  })

  test("is one mailbox's, not every mailbox's", async () => {
    const { password } = await createAppPassword({ address: family, name: "Only family" })
    expect(await authenticateAddress(`owner@${zone}`, password, undefined, "imap")).toBeNull()
  })

  test("works on a mailbox that shares its owner's account password", async () => {
    const { password } = await createAppPassword({ address: linked, name: "Owner phone" })
    expect(await imapLogin(`owner@${zone}`, password)).toContain("a1 OK")
    expect(await imapLogin(`owner@${zone}`, ACCOUNT_PASSWORD)).toContain("a1 OK")
  })
})

describe("revocation", () => {
  test("a deleted app password stops on every protocol at once", async () => {
    const { appPassword, password } = await createAppPassword({ address: family, name: "Lost" })
    expect(await imapLogin(`family@${zone}`, password)).toContain("a1 OK")

    expect(await deleteAppPassword(family.id, appPassword.id)).toBe(true)
    expect(await imapLogin(`family@${zone}`, password)).toContain("a1 NO")
    expect(await smtpAuth(`family@${zone}`, password)).toStartWith("535 ")
  })

  test("cannot be deleted through another mailbox", async () => {
    const { appPassword } = await createAppPassword({ address: family, name: "Mine" })
    expect(await deleteAppPassword(linked.id, appPassword.id)).toBe(false)
  })

  test("changing the mailbox password leaves app passwords working", async () => {
    const { password } = await createAppPassword({ address: family, name: "Survivor" })
    await setPassword(family.id, "rotated-password-1234")
    expect(await imapLogin(`family@${zone}`, password)).toContain("a1 OK")
    await setPassword(family.id, MAILBOX_PASSWORD)
  })

  test("disabling the mailbox refuses them", async () => {
    const { password } = await createAppPassword({ address: family, name: "Disabled" })
    await db().execute(
      from(addresses)
        .where((q) => q("id").equals(family.id))
        .update({ disabled: true }),
    )
    expect(await imapLogin(`family@${zone}`, password)).toContain("a1 NO")
    await db().execute(
      from(addresses)
        .where((q) => q("id").equals(family.id))
        .update({ disabled: false }),
    )
    expect(await imapLogin(`family@${zone}`, password)).toContain("a1 OK")
  })
})

describe("scopes", () => {
  test("an IMAP-only app password does not open SMTP", async () => {
    const { password } = await createAppPassword({
      address: family,
      name: "Reader",
      scopes: ["imap"],
    })
    expect(await imapLogin(`family@${zone}`, password)).toContain("a1 OK")
    expect(await smtpAuth(`family@${zone}`, password)).toStartWith("535 ")
  })

  test("a caller that names no protocol needs an unrestricted one", async () => {
    const restricted = await createAppPassword({ address: family, name: "R", scopes: ["imap"] })
    const full = await createAppPassword({ address: family, name: "F" })
    expect(await authenticateAddress(`family@${zone}`, restricted.password)).toBeNull()
    expect(await authenticateAddress(`family@${zone}`, full.password)).not.toBeNull()
  })

  test("are stored in a fixed order without duplicates", async () => {
    const { appPassword } = await createAppPassword({
      address: family,
      name: "Order",
      scopes: ["smtp", "imap", "smtp"],
    })
    expect(appPassword.scopes).toEqual(["imap", "smtp"])
  })
})

describe("require_app_passwords", () => {
  test("refuses the mailbox password on the protocols", async () => {
    await setRequire(family.id, true)
    try {
      expect(await imapLogin(`family@${zone}`, MAILBOX_PASSWORD)).toContain("a1 NO")
      expect(await smtpAuth(`family@${zone}`, MAILBOX_PASSWORD)).toStartWith("535 ")
      const { password } = await createAppPassword({ address: family, name: "Required" })
      expect(await imapLogin(`family@${zone}`, password)).toContain("a1 OK")
    } finally {
      await setRequire(family.id, false)
    }
  })

  test("refuses the account password on a linked mailbox", async () => {
    await setRequire(linked.id, true)
    try {
      expect(await imapLogin(`owner@${zone}`, ACCOUNT_PASSWORD)).toContain("a1 NO")
    } finally {
      await setRequire(linked.id, false)
    }
  })

  test("does not touch the webmail, which takes the real password and never an app password", async () => {
    await setRequire(family.id, true)
    try {
      const { password } = await createAppPassword({ address: family, name: "Not webmail" })
      expect(
        await authenticateAddress(`family@${zone}`, MAILBOX_PASSWORD, undefined, "webmail"),
      ).not.toBeNull()
      expect(await authenticateAddress(`family@${zone}`, password, undefined, "webmail")).toBeNull()
    } finally {
      await setRequire(family.id, false)
    }
  })

  test("still spends a password verify before refusing", async () => {
    await setRequire(family.id, true)
    try {
      const time = async (password: string) => {
        let best = Number.POSITIVE_INFINITY
        for (let i = 0; i < 3; i++) {
          const start = performance.now()
          await authenticateAddress(`family@${zone}`, password, undefined, "imap")
          best = Math.min(best, performance.now() - start)
        }
        return best
      }
      const refused = await time(MAILBOX_PASSWORD)
      const unknown = await (async () => {
        const start = performance.now()
        await authenticateAddress(`nobody@${zone}`, MAILBOX_PASSWORD, undefined, "imap")
        return performance.now() - start
      })()
      // Loose on purpose: the point is that the refusal is not a bare query.
      expect(refused).toBeGreaterThan(unknown * 0.4)
    } finally {
      await setRequire(family.id, false)
    }
  })
})

describe("who can have one", () => {
  test("an agent mailbox is refused — it already has a revocable token", async () => {
    const { address } = await createAgent({ userId: ownerId, domain, name: "Bot" })
    await expect(createAppPassword({ address, name: "Nope" })).rejects.toThrow("Only a mailbox")
  })

  test("an alias is refused — it has nothing to sign into", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "alias",
      type: "alias",
      destinations: [`family@${zone}`],
    })
    await expect(createAppPassword({ address, name: "Nope" })).rejects.toThrow("Only a mailbox")
  })
})

describe("storage and serialisation", () => {
  test("the serialiser carries neither the hash nor the secret", async () => {
    const { appPassword, password } = await createAppPassword({ address: family, name: "Shape" })
    const body = JSON.stringify(appPasswordObject(appPassword))
    expect(body).not.toContain("token_hash")
    expect(body).not.toContain(appPassword.token_hash)
    expect(body).not.toContain(password)
    expect(body).not.toContain(password.replace(/-/g, ""))
  })

  test("only a SHA-256 of the canonical secret is stored", async () => {
    const { appPassword, password } = await createAppPassword({ address: family, name: "Hash" })
    const expected = new Bun.CryptoHasher("sha256").update(password.replace(/-/g, "")).digest("hex")
    expect(appPassword.token_hash).toBe(expected)
  })

  /**
   * The match reads every row for the mailbox and compares digests with
   * `timingSafeEqual`, rather than asking Postgres for `token_hash = $1`, whose
   * index lookup and string compare are neither constant-time nor ours.
   */
  test("the compare is constant-time", async () => {
    const source = await Bun.file(new URL("../src/apppasswords/index.ts", import.meta.url)).text()
    const body = source.slice(source.indexOf("export const matchAppPassword"))
    const fn = body.slice(0, body.indexOf("\n}\n"))
    expect(fn).toContain("timingSafeEqual")
    expect(fn).not.toMatch(/token_hash\s*=/)
    expect(fn).not.toContain("return row")
  })

  test("the address reports whether it requires them", async () => {
    const { addressObject } = await import("../src/serialize/index.ts")
    expect(addressObject(await reload(family.id)).require_app_passwords).toBe(false)
  })
})

describe("over HTTP", () => {
  const app = buildFetch(null)
  const call = (path: string, cookie: string, init: { method?: string; body?: unknown } = {}) =>
    app(
      new Request(`http://corsair.test${path}`, {
        method: init.method ?? "GET",
        headers: { cookie, "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    )

  const panel = async () => `${SESSION_COOKIE}=${(await issueSession(ownerId)).token}`

  test("the panel creates, lists and revokes, and never returns the hash", async () => {
    const cookie = await panel()
    const created = await call(`/api/addresses/${family.id}/app-passwords`, cookie, {
      method: "POST",
      body: { name: "HTTP phone", scopes: ["imap"] },
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as Record<string, unknown>
    expect(String(body.password)).toMatch(/^[a-kmnp-z2-9]{4}(-[a-kmnp-z2-9]{4}){4}$/)
    expect(body.token_hash).toBeUndefined()
    expect(body.scopes).toEqual(["imap"])

    const listed = await call(`/api/addresses/${family.id}/app-passwords`, cookie)
    const list = await listed.text()
    expect(list).not.toContain("token_hash")
    expect(list).not.toContain(String(body.password))

    const gone = await call(`/api/addresses/${family.id}/app-passwords/${body.id}`, cookie, {
      method: "DELETE",
    })
    expect(gone.status).toBe(200)
    expect(await imapLogin(`family@${zone}`, String(body.password))).toContain("a1 NO")
  })

  test("recommends requiring them where the account behind the mailbox has 2FA", async () => {
    const cookie = await panel()
    const linkedList = (await (
      await call(`/api/addresses/${linked.id}/app-passwords`, cookie)
    ).json()) as { totp_recommended: boolean }
    expect(linkedList.totp_recommended).toBe(true)
    const familyList = (await (
      await call(`/api/addresses/${family.id}/app-passwords`, cookie)
    ).json()) as { totp_recommended: boolean }
    expect(familyList.totp_recommended).toBe(false)
  })

  test("the address can be made to require them, and the panel sees it", async () => {
    const cookie = await panel()
    const res = await call(`/api/addresses/${family.id}`, cookie, {
      method: "PATCH",
      body: { require_app_passwords: true },
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as { require_app_passwords: boolean }).require_app_passwords).toBe(
      true,
    )
    await setRequire(family.id, false)
  })

  test("someone with no grant on the domain cannot reach them", async () => {
    const strangerId = (await db().one<{ id: string }>({
      text: `INSERT INTO users (email, password_hash, name, referral_code)
             VALUES ($1, 'x', 'Stranger', $2) RETURNING id`,
      values: [`stranger-${suffix}@corsair.test`, `st${suffix}`],
    }))!.id
    try {
      const cookie = `${SESSION_COOKIE}=${(await issueSession(strangerId)).token}`
      expect((await call(`/api/addresses/${family.id}/app-passwords`, cookie)).status).toBe(404)
    } finally {
      await db().execute(
        from(users)
          .where((q) => q("id").equals(strangerId))
          .del(),
      )
    }
  })

  test("the webmail manages its own, with the current password to create one", async () => {
    const cookie = `${MAIL_COOKIE}=${await issueMailSession(family.id)}`
    const refused = await call("/api/mail/app-passwords", cookie, {
      method: "POST",
      body: { name: "Webmail made", current_password: "wrong-password-0000" },
    })
    expect(refused.status).toBe(401)

    const created = await call("/api/mail/app-passwords", cookie, {
      method: "POST",
      body: { name: "Webmail made", current_password: MAILBOX_PASSWORD },
    })
    expect(created.status).toBe(201)
    const body = (await created.json()) as { id: string; password: string }
    expect(await imapLogin(`family@${zone}`, body.password)).toContain("a1 OK")

    const listed = await call("/api/mail/app-passwords", cookie)
    expect(await listed.text()).not.toContain("token_hash")

    const gone = await call(`/api/mail/app-passwords/${body.id}`, cookie, { method: "DELETE" })
    expect(gone.status).toBe(200)
  })

  test("JMAP Basic takes an app password", async () => {
    const { password } = await createAppPassword({ address: family, name: "JMAP" })
    const basic = Buffer.from(`family@${zone}:${password}`).toString("base64")
    const res = await app(
      new Request("http://corsair.test/.well-known/jmap", {
        headers: { authorization: `Basic ${basic}` },
      }),
    )
    expect(res.status).toBe(200)
  })
})
