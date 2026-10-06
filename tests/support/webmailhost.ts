import { afterAll, beforeAll, expect, test } from "bun:test"
import { startApi } from "../../src/api/index.ts"
import { createAddress } from "../../src/addresses/index.ts"
import { config } from "../../src/config/index.ts"
import { db } from "../../src/db/index.ts"
import { recordSpec, syncRecords } from "../../src/domains/index.ts"
import { domainObject } from "../../src/serialize/index.ts"
import type { Domain } from "../../src/schema/index.ts"
import { allowsWebmailHost, webmailDomain } from "../../src/webmailhost/index.ts"

const enabled = Boolean(config.mail.webmail)
const suffix = crypto.randomUUID().slice(0, 8)
const name = `webmail-${suffix}.invalid`
let userId = ""
let domain: Domain
let server: Awaited<ReturnType<typeof startApi>>

beforeAll(async () => {
  userId = (await db().one<{ id: string }>({
    text: "INSERT INTO users (email, referral_code) VALUES ($1, $2) RETURNING id",
    values: [`owner@${name}`, suffix],
  }))!.id
  domain = (await db().one<Domain>({
    text: "INSERT INTO domains (user_id, name, verification_token, status) VALUES ($1, $2, 'test', 'active') RETURNING *",
    values: [userId, name],
  }))!
  server = await startApi(0)
})

afterAll(async () => {
  server?.stop(true)
  if (userId) await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [userId] })
})

const request = (path: string, host = `webmail.${name}`): Promise<Response> =>
  fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { host } })

test("only a bare webmail hostname is accepted", () => {
  expect(webmailDomain(`WEBMAIL.${name.toUpperCase()}.`)).toBe(enabled ? name : null)
  for (const host of [
    name,
    `mail.${name}`,
    `webmail.${name}:443`,
    `https://webmail.${name}`,
    `webmail.${name}/`,
    `webmail.bad..invalid`,
  ]) {
    expect(webmailDomain(host)).toBeNull()
  }
})

test("webmail DNS is optional and existing domains acquire it on sync", async () => {
  const spec = recordSpec({ domain: name, verificationToken: "test", dkim: [] })
  const webmail = spec.find((r) => r.purpose === "webmail")
  if (enabled)
    expect(webmail).toMatchObject({
      type: "CNAME",
      host: "webmail",
      value: config.mail.webmail,
      required: false,
    })
  else expect(webmail).toBeUndefined()
  const records = await syncRecords(domain, [])
  expect(records.some((r) => r.purpose === "webmail")).toBe(enabled)
  expect(domainObject(domain, records).webmail_url).toBe(enabled ? `https://webmail.${name}` : null)
  expect((await syncRecords(domain, [])).length).toBe(records.length)
})

test("approval requires an active hosted domain and is revoked on deletion", async () => {
  const ask = (host: string) =>
    request(`/api/webmail/host?domain=${encodeURIComponent(host)}`, "localhost")
  expect((await ask(`webmail.${name}`)).status).toBe(enabled ? 200 : 403)
  for (const host of [name, `webmail.unhosted.invalid`, `other.${name}`, "", `${name}:443`]) {
    expect((await ask(host)).status).toBe(403)
  }
  await db().execute({
    text: "UPDATE domains SET status = 'pending' WHERE id = $1",
    values: [domain.id],
  })
  expect(await allowsWebmailHost(`webmail.${name}`)).toBe(false)
  expect((await ask(`webmail.${name}`)).status).toBe(403)
  await db().execute({
    text: "UPDATE domains SET status = 'active' WHERE id = $1",
    values: [domain.id],
  })
  const deletedName = `deleted-${suffix}.invalid`
  await db().execute({
    text: "INSERT INTO domains (user_id, name, verification_token, status) VALUES ($1, $2, 'test', 'active')",
    values: [userId, deletedName],
  })
  expect(await allowsWebmailHost(`webmail.${deletedName}`)).toBe(enabled)
  await db().execute({ text: "DELETE FROM domains WHERE name = $1", values: [deletedName] })
  expect((await ask(`webmail.${deletedName}`)).status).toBe(403)
})

test("the customer root serves webmail with hardened headers and working assets", async () => {
  if (!enabled) return
  const root = await request("/")
  const html = await root.text()
  expect(root.status).toBe(200)
  expect(html).toBe(await (await request("/webmail")).text())
  expect(root.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
  expect(root.headers.get("x-frame-options")).toBe("DENY")
  const script = html.match(/src="(\/[^"]+\.js)"/)?.[1]
  expect(script).toBeTruthy()
  expect((await request(script!)).status).toBe(200)
  expect((await request("/api/mail/me")).status).toBe(401)
  expect((await request("/app")).status).toBe(404)
  expect((await request("/api/domains")).status).toBe(404)
  expect((await request("/docs/webmail")).status).toBe(404)
  expect((await request("/", "webmail.unhosted.invalid")).status).toBe(404)
  // proxy claims do not select a customer host
  const shared = await fetch(`http://127.0.0.1:${server.port}/`, {
    headers: { "x-forwarded-host": `webmail.${name}` },
  })
  expect(await shared.text()).not.toBe(html)
})

test("mailbox login and logout stay on the customer hostname", async () => {
  if (!enabled) return
  await createAddress({
    domainId: domain.id,
    localPart: "reader",
    type: "standard",
    password: "webmail-test-password-1234",
  })
  const login = await fetch(`http://127.0.0.1:${server.port}/api/mail/login`, {
    method: "POST",
    headers: { host: `webmail.${name}`, "content-type": "application/json" },
    body: JSON.stringify({ email: `reader@${name}`, password: "webmail-test-password-1234" }),
  })
  expect(login.status).toBe(200)
  const setCookie = login.headers.get("set-cookie")!
  expect(setCookie).toContain("HttpOnly")
  expect(setCookie).not.toContain("Domain=")
  const headers = { host: `webmail.${name}`, cookie: setCookie.split(";")[0]! }
  const me = await fetch(`http://127.0.0.1:${server.port}/api/mail/me`, { headers })
  expect(me.status).toBe(200)
  const mailbox = await me.json()
  expect(mailbox.email).toBe(`reader@${name}`)
  expect(mailbox.account_url).toBe(`${config.publicUrl.replace(/\/$/, "")}/app/account`)
  const logout = await fetch(`http://127.0.0.1:${server.port}/api/mail/logout`, {
    method: "POST",
    headers,
  })
  expect(logout.status).toBe(200)
  expect((await fetch(`http://127.0.0.1:${server.port}/api/mail/me`, { headers })).status).toBe(401)
})
