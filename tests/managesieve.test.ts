import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@wess/atlas/db/query"
import { createAddress } from "../src/addresses/index.ts"
import { db } from "../src/db/index.ts"
import { createManageSieveSession } from "../src/managesieve/session/index.ts"
import { type Domain, users } from "../src/schema/index.ts"

const suffix = Math.random().toString(36).slice(2, 8)
const domainName = `sv-${suffix}.invalid`
const password = "hunter2hunter2"

let ownerId = ""
let ownerEmail = ""
let domain: Domain
let planId = ""
let poorId = ""

const plain = (email: string, secret = password) =>
  Buffer.from(`\0${email}\0${secret}`).toString("base64")

const open = (options: { secure?: boolean; startTls?: () => void } = {}) => {
  const failures: string[] = []
  let authed = 0
  const session = createManageSieveSession({
    isSecure: () => options.secure ?? true,
    remoteIp: "203.0.113.9",
    ...(options.startTls ? { startTls: options.startTls } : {}),
    onAuthFailure: (u) => failures.push(u),
    onAuthSuccess: () => authed++,
  })
  return {
    session,
    failures,
    authed: () => authed,
    send: (text: string) => session.feed(text),
  }
}

const loggedIn = async (email = ownerEmail) => {
  const client = open()
  const out = await client.send(`AUTHENTICATE "PLAIN" "${plain(email)}"\r\n`)
  expect(out).toStartWith("OK")
  return client
}

const rowsFor = (userId: string) =>
  db().all<{ name: string; script: string; size: number }>({
    text: "SELECT name, script, size FROM filters WHERE user_id = $1 ORDER BY name",
    values: [userId],
  })

beforeAll(async () => {
  ownerEmail = `owner@${domainName}`
  const hash = await Bun.password.hash(password)
  const owner = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, $2, 'Owner', $3) RETURNING id`,
    values: [ownerEmail, hash, `o${suffix}`],
  })
  ownerId = owner!.id
  domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=test', 'active') RETURNING *`,
    values: [ownerId, domainName],
  }))!
  // The owner's own mailbox shares the account password; "family" has its own.
  await createAddress({
    domainId: domain.id,
    localPart: "owner",
    type: "standard",
    ownerId,
  } as never)
  await createAddress({ domainId: domain.id, localPart: "family", type: "standard", password })
})

afterAll(async () => {
  for (const id of [ownerId, poorId]) {
    if (id)
      await db().execute(
        from(users)
          .where((q) => q("id").equals(id))
          .del(),
      )
  }
  if (planId) await db().execute({ text: "DELETE FROM plans WHERE id = $1", values: [planId] })
})

describe("capabilities", () => {
  test("greeting lists implementation, version and the engine's extensions", () => {
    const out = open({ secure: false }).session.greeting()
    expect(out).toContain('"IMPLEMENTATION" "Corsair"')
    expect(out).toContain('"VERSION" "1.0"')
    expect(out).toMatch(/"SIEVE" "[^"]*fileinto[^"]*"/)
    expect(out).toEndWith('ready."\r\n')
    expect(out).toContain("OK ")
  })

  test("SASL is empty and STARTTLS offered only while in the clear", () => {
    const clear = open({ secure: false, startTls: () => {} }).session.greeting()
    expect(clear).toContain('"SASL" ""')
    expect(clear).toContain('"STARTTLS"')
    const tls = open({ secure: true, startTls: () => {} }).session.greeting()
    expect(tls).toContain('"SASL" "PLAIN"')
    expect(tls).not.toContain("STARTTLS")
  })

  test("STARTTLS is not offered when the runtime cannot do it", () => {
    expect(open({ secure: false }).session.greeting()).not.toContain("STARTTLS")
  })
})

describe("authentication", () => {
  test("refuses PLAIN before TLS", async () => {
    const client = open({ secure: false })
    const out = await client.send(`AUTHENTICATE "PLAIN" "${plain(ownerEmail)}"\r\n`)
    expect(out).toStartWith("NO (ENCRYPT-NEEDED)")
    expect(client.failures).toEqual([])
  })

  test("accepts PLAIN with an initial response", async () => {
    const client = open()
    expect(await client.send(`AUTHENTICATE "PLAIN" "${plain(ownerEmail)}"\r\n`)).toStartWith("OK")
    expect(client.authed()).toBe(1)
  })

  test("accepts PLAIN after an empty challenge", async () => {
    const client = open()
    expect(await client.send('AUTHENTICATE "PLAIN"\r\n')).toBe('""\r\n')
    expect(await client.send(`"${plain(ownerEmail)}"\r\n`)).toStartWith("OK")
  })

  test("a wrong password is a NO, and is recorded for the ban", async () => {
    const client = open()
    const out = await client.send(`AUTHENTICATE "PLAIN" "${plain(ownerEmail, "nope-nope")}"\r\n`)
    expect(out).toStartWith("NO")
    expect(client.failures).toEqual([ownerEmail])
    expect(await client.send("LISTSCRIPTS\r\n")).toStartWith("NO")
  })

  test("an unknown mailbox answers the same way", async () => {
    const a = await open().send(`AUTHENTICATE "PLAIN" "${plain(`ghost@${domainName}`)}"\r\n`)
    const b = await open().send(`AUTHENTICATE "PLAIN" "${plain(ownerEmail, "nope-nope")}"\r\n`)
    expect(a).toBe(b)
  })

  test("commands before login are refused", async () => {
    const client = open()
    for (const line of ["LISTSCRIPTS", 'GETSCRIPT "a"', 'PUTSCRIPT "a" ""', "CHECKSCRIPT {0+}\n"]) {
      expect(await client.send(`${line}\r\n`)).toStartWith("NO")
    }
  })

  test("a mailbox that is not its owner's account is refused with right credentials", async () => {
    const client = open()
    const out = await client.send(`AUTHENTICATE "PLAIN" "${plain(`family@${domainName}`)}"\r\n`)
    expect(out).toStartWith("NO")
    expect(client.failures).toEqual([])
    expect(await client.send("LISTSCRIPTS\r\n")).toStartWith("NO")
  })
})

describe("scripts", () => {
  test("PUTSCRIPT with a quoted-name, literal body writes the shared filters row", async () => {
    const client = await loggedIn()
    const script = 'require "fileinto";\nif header :contains "subject" "x" { fileinto "X"; }\n'
    const out = await client.send(`PUTSCRIPT "main" {${script.length}+}\r\n${script}\r\n`)
    expect(out).toStartWith("OK")
    const rows = await rowsFor(ownerId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.name).toBe("main")
    expect(rows[0]!.script).toBe(script)
  })

  test("a synchronising literal and a split delivery both work", async () => {
    const client = await loggedIn()
    const script = "keep;"
    expect(await client.send(`PUTSCRIPT "sync" {${script.length}}\r\n`)).toBe("")
    expect(await client.send(`${script}\r\n`)).toStartWith("OK")
    expect(await client.send('PUTSCRIPT "split" {5+}\r\nke')).toBe("")
    expect(await client.send("ep;\r\n")).toStartWith("OK")
    expect((await rowsFor(ownerId)).map((r) => r.name)).toContain("split")
  })

  test("pipelined commands in one chunk are all answered", async () => {
    const client = await loggedIn()
    const out = await client.send('NOOP\r\nNOOP "abc"\r\nLISTSCRIPTS\r\n')
    expect(out).toContain('OK (TAG "abc")')
    expect(out.match(/^OK/gm)?.length).toBeGreaterThanOrEqual(3)
  })

  test("script and name bytes are UTF-8 and sizes are octets", async () => {
    const client = await loggedIn()
    const script = "# café\nkeep;\n"
    const bytes = Buffer.from(script)
    const name = "régle"
    // Wire strings are latin1: one character per octet.
    const wire = (s: string) => Buffer.from(s).toString("latin1")
    expect(
      await client.send(`PUTSCRIPT "${wire(name)}" {${bytes.length}+}\r\n${wire(script)}\r\n`),
    ).toStartWith("OK")
    const stored = (await rowsFor(ownerId)).find((r) => r.name === name)
    expect(stored?.script).toBe(script)
    const got = await client.send(`GETSCRIPT "${wire(name)}"\r\n`)
    expect(got).toStartWith(`{${bytes.length}}\r\n${wire(script)}\r\nOK`)
  })

  test("a script that does not compile is refused and not stored", async () => {
    const client = await loggedIn()
    const out = await client.send('PUTSCRIPT "broken" {13+}\r\nif nonsense {\r\n')
    expect(out).toStartWith("NO")
    expect((await rowsFor(ownerId)).map((r) => r.name)).not.toContain("broken")
  })

  test("CHECKSCRIPT validates without storing", async () => {
    const client = await loggedIn()
    expect(await client.send("CHECKSCRIPT {5+}\r\nkeep;\r\n")).toStartWith("OK")
    expect(await client.send("CHECKSCRIPT {8+}\r\nif x { }\r\n")).toStartWith("NO")
  })

  test("LISTSCRIPTS, SETACTIVE, DELETESCRIPT and RENAMESCRIPT", async () => {
    const client = await loggedIn()
    await client.send('PUTSCRIPT "alpha" {5+}\r\nkeep;\r\n')
    await client.send('PUTSCRIPT "beta" {5+}\r\nkeep;\r\n')

    expect(await client.send('SETACTIVE "alpha"\r\n')).toStartWith("OK")
    const listed = await client.send("LISTSCRIPTS\r\n")
    expect(listed).toContain('"alpha" ACTIVE\r\n')
    expect(listed).toContain('"beta"\r\n')

    // The same state the panel reads: the mailbox's filter_id.
    const row = await db().one<{ name: string }>({
      text: `SELECT f.name FROM addresses a JOIN filters f ON f.id = a.filter_id
              WHERE a.domain_id = $1 AND a.local_part = 'owner'`,
      values: [domain.id],
    })
    expect(row?.name).toBe("alpha")

    expect(await client.send('DELETESCRIPT "alpha"\r\n')).toStartWith("NO (ACTIVE)")
    expect(await client.send('SETACTIVE "nothere"\r\n')).toStartWith("NO (NONEXISTENT)")
    expect(await client.send('RENAMESCRIPT "beta" "alpha"\r\n')).toStartWith("NO (ALREADYEXISTS)")
    expect(await client.send('RENAMESCRIPT "beta" "gamma"\r\n')).toStartWith("OK")
    expect(await client.send('DELETESCRIPT "gamma"\r\n')).toStartWith("OK")
    expect(await client.send('GETSCRIPT "gamma"\r\n')).toStartWith("NO (NONEXISTENT)")

    // Renaming the active script keeps it active: the id is what is referenced.
    expect(await client.send('RENAMESCRIPT "alpha" "omega"\r\n')).toStartWith("OK")
    expect(await client.send("LISTSCRIPTS\r\n")).toContain('"omega" ACTIVE')

    expect(await client.send('SETACTIVE ""\r\n')).toStartWith("OK")
    expect(await client.send("LISTSCRIPTS\r\n")).not.toContain("ACTIVE")
    expect(await client.send('DELETESCRIPT "omega"\r\n')).toStartWith("OK")
  })

  test("a script created elsewhere (the API's table) is listed and readable", async () => {
    await db().execute({
      text: "INSERT INTO filters (user_id, name, script, size) VALUES ($1, 'from-panel', 'keep;', 5)",
      values: [ownerId],
    })
    const client = await loggedIn()
    expect(await client.send("LISTSCRIPTS\r\n")).toContain('"from-panel"')
    expect(await client.send('GETSCRIPT "from-panel"\r\n')).toStartWith("{5}\r\nkeep;\r\nOK")
  })

  test("HAVESPACE honours the size cap", async () => {
    const client = await loggedIn()
    expect(await client.send('HAVESPACE "x" 100\r\n')).toStartWith("OK")
    expect(await client.send('HAVESPACE "x" 9999999\r\n')).toStartWith("NO (QUOTA/MAXSIZE)")
  })

  test("UNAUTHENTICATE drops the identity", async () => {
    const client = await loggedIn()
    expect(await client.send("UNAUTHENTICATE\r\n")).toStartWith("OK")
    expect(await client.send("LISTSCRIPTS\r\n")).toStartWith("NO")
  })
})

describe("plan gating", () => {
  test("saving needs custom_filters; checking and reading do not", async () => {
    const hash = await Bun.password.hash(password)
    const poorEmail = `poor@${domainName}`
    const poor = await db().one<{ id: string }>({
      text: `INSERT INTO users (email, password_hash, name, referral_code)
             VALUES ($1, $2, 'Poor', $3) RETURNING id`,
      values: [`poor-${suffix}@corsair.test`, hash, `p${suffix}`],
    })
    poorId = poor!.id
    const plan = await db().one<{ id: string }>({
      text: `INSERT INTO plans (key, name, storage_bytes, daily_in, daily_out, features)
             VALUES ($1, 'Bare', 1000000, 10, 10, '{}'::jsonb) RETURNING id`,
      values: [`bare-${suffix}`],
    })
    planId = plan!.id
    await db().execute({
      text: `INSERT INTO subscriptions (user_id, plan_id, status, current_period_end)
             VALUES ($1, $2, 'active', now() + interval '30 days')`,
      values: [poorId, planId],
    })
    const other = await db().one<Domain>({
      text: `INSERT INTO domains (user_id, name, verification_token, status)
             VALUES ($1, $2, 'mail-host-verify=test', 'active') RETURNING *`,
      values: [poorId, `poor-${domainName}`],
    })
    // Linked to the account by sharing its address.
    await db().execute({
      text: "UPDATE users SET email = $2 WHERE id = $1",
      values: [poorId, `me@poor-${domainName}`],
    })
    await createAddress({
      domainId: other!.id,
      localPart: "me",
      type: "standard",
      ownerId: poorId,
      useAccountPassword: true,
    } as never)
    void poorEmail

    const client = open()
    const login = await client.send(`AUTHENTICATE "PLAIN" "${plain(`me@poor-${domainName}`)}"\r\n`)
    expect(login).toStartWith("OK")

    expect(await client.send('PUTSCRIPT "a" {5+}\r\nkeep;\r\n')).toStartWith("NO")
    expect(await client.send('HAVESPACE "a" 5\r\n')).toStartWith("NO")
    expect(await client.send("CHECKSCRIPT {5+}\r\nkeep;\r\n")).toStartWith("OK")
    expect(await client.send("LISTSCRIPTS\r\n")).toStartWith("OK")
    expect(await rowsFor(poorId)).toHaveLength(0)
  })
})

describe("bounds", () => {
  test("an oversized line before login closes the connection", async () => {
    const client = open()
    const out = await client.send(`NOOP "${"a".repeat(9_000)}`)
    expect(out).toContain("BYE")
    expect(client.session.shouldClose()).toBe(true)
  })

  test("an oversized literal before login is refused from its header", async () => {
    const client = open()
    const out = await client.send("AUTHENTICATE {9000+}\r\n")
    expect(out).toContain("BYE")
    expect(client.session.shouldClose()).toBe(true)
  })

  test("an oversized script after login is refused from its header", async () => {
    const client = await loggedIn()
    const out = await client.send('PUTSCRIPT "big" {1000000+}\r\n')
    expect(out).toStartWith("NO (QUOTA/MAXSIZE)")
    expect(client.session.shouldClose()).toBe(true)
  })

  test("a malformed command closes the connection", async () => {
    const client = open()
    expect(await client.send("NOOP {abc}\r\n")).toContain("BYE")
  })

  test("STARTTLS asks the listener to upgrade", async () => {
    let upgrades = 0
    const client = open({ secure: false, startTls: () => upgrades++ })
    expect(await client.send("STARTTLS\r\n")).toStartWith("OK")
    expect(upgrades).toBe(1)
  })

  test("bytes pipelined behind STARTTLS end the connection instead of upgrading", async () => {
    let upgrades = 0
    const client = open({ secure: false, startTls: () => upgrades++ })
    const out = await client.send('STARTTLS\r\nAUTHENTICATE "PLAIN" "AGE="\r\n')
    expect(out).toContain("BYE")
    expect(upgrades).toBe(0)
    expect(client.session.shouldClose()).toBe(true)
  })

  test("LOGOUT closes", async () => {
    const client = open()
    expect(await client.send("LOGOUT\r\n")).toStartWith("OK")
    expect(client.session.shouldClose()).toBe(true)
  })
})
