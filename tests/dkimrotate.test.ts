import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { from } from "@wess/atlas/db/query"
import { config } from "../src/config/index.ts"
import { db } from "../src/db/index.ts"
import { dkimRecord } from "../src/dkim/index.ts"
import {
  advance,
  ensureHosts,
  expectedRecord,
  keyResolves,
  REVOKED_RECORD,
  type Resolver,
  recordMatches,
  startRotation,
} from "../src/dkimrotate/index.ts"
import { activeDkimKey, createDomain } from "../src/domains/index.ts"
import { type DkimHost, type DkimKey, dkimKeys, domainRecords } from "../src/schema/index.ts"

/**
 * The invariant: signing moves to a key only after that key's TXT was resolved
 * and matched. A signature with a key nobody can verify is well-formed and logs
 * nothing, so every refusal here is something that would otherwise fail silently
 * at every receiver.
 *
 * DNS is a stub; nothing here touches the network. Needs `bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const made: string[] = []
const [H1, H2, H3] = config.mail.dkimHosts as [string, string, string]
const T0 = new Date("2026-11-01T00:00:00Z")
const later = (hours: number) => new Date(T0.getTime() + hours * 3_600_000)

let dns = new Map<string, string[]>()
const resolve: Resolver = async (name) => {
  const v = dns.get(name)
  if (!v) throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" })
  return v
}

const makeUser = async () => {
  const id = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Rot', $2) RETURNING id`,
    values: [`rot-${suffix}-${made.length}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id
  made.push(id)
  return id
}

const keysOf = (domainId: string) =>
  db().all<DkimKey>(
    from(dkimKeys)
      .where((q) => q("domain_id").equals(domainId))
      .orderBy("position", "ASC"),
  )

const phases = async () =>
  Object.fromEntries((await ensureHosts()).map((h: DkimHost) => [h.host, h.phase]))

let domainName: string
let domainId: string

beforeEach(async () => {
  // Rotation state is installation-wide; every test starts from a fresh install
  // whose domains all sign with the first host.
  await db().execute({ text: "DELETE FROM dkim_hosts", values: [] })
  await db().execute({ text: "UPDATE dkim_keys SET active = false", values: [] })
  await db().execute({ text: "UPDATE dkim_keys SET active = true WHERE position = 0", values: [] })
  dns = new Map()
  if (!domainId) {
    domainName = `rot-${suffix}.invalid`
    domainId = (await createDomain({ userId: await makeUser(), name: domainName })).domain.id
  }
})

afterAll(async () => {
  await db().execute({ text: "DELETE FROM dkim_hosts", values: [] })
  for (const id of made) {
    await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [id] })
  }
})

/** Publishes, in the stub, what the operator would: host TXT and the customer's CNAME chain. */
const publishHost = async (host: string, record?: string) => {
  const h = (await ensureHosts()).find((x) => x.host === host)!
  dns.set(host, [record ?? (await expectedRecord(h))!])
}
const publishDomain = async (selectorPos: number) => {
  const key = (await keysOf(domainId))[selectorPos]!
  dns.set(`${key.selector}._domainkey.${domainName}`, [dkimRecord(key.public_key)])
}

describe("recordMatches", () => {
  const rec = "v=DKIM1; k=rsa; p=QUJD"
  test("compares the key, not the formatting", () => {
    expect(recordMatches(["v=DKIM1;k=rsa;p=Q UJD"], rec)).toBe(true)
    expect(recordMatches(["v=DKIM1; k=rsa; p=WFla"], rec)).toBe(false)
  })
  test("accepts a record Bun split into chunks", () => {
    expect(recordMatches(["v=DKIM1; k=rsa; p=QU", "JD"], rec)).toBe(true)
  })
  test("an empty p= matches only an empty p=", () => {
    expect(recordMatches([REVOKED_RECORD], REVOKED_RECORD)).toBe(true)
    expect(recordMatches([rec], REVOKED_RECORD)).toBe(false)
    expect(recordMatches(["v=DKIM1; k=rsa"], REVOKED_RECORD)).toBe(false)
  })
})

describe("phase machine", () => {
  test("an existing install adopts the first host as active", async () => {
    expect(await phases()).toEqual({ [H1]: "active", [H2]: "spare", [H3]: "spare" })
  })

  test("rotate stages a fresh key on the next host and signs with nothing new", async () => {
    await ensureHosts()
    const before = (await keysOf(domainId))[1]!.public_key
    const staged = await startRotation(T0)
    expect(staged.host).toBe(H2)

    const after = await keysOf(domainId)
    expect(after[1]!.public_key).not.toBe(before)
    expect(dkimRecord(after[1]!.public_key)).toBe(staged.record)
    expect(await phases()).toEqual({ [H1]: "active", [H2]: "staged", [H3]: "spare" })
    expect((await activeDkimKey(domainId))?.selector).toBe("corsair-1")
    await expect(startRotation(T0)).rejects.toThrow("already in progress")
  })

  test("walks staged, published, active, retiring, revoked on observed DNS", async () => {
    await startRotation(T0)
    const opts = { resolve, soakHours: 48, retireDays: 7 }

    // Nothing published: nothing moves, however long we wait.
    await advance({ ...opts, now: later(100) })
    expect((await phases())[H2]).toBe("staged")

    await publishHost(H2)
    await advance({ ...opts, now: later(100) })
    expect((await phases())[H2]).toBe("published")

    // Still soaking.
    await publishDomain(1)
    await advance({ ...opts, now: later(120) })
    expect((await phases())[H2]).toBe("published")
    expect((await activeDkimKey(domainId))?.selector).toBe("corsair-1")

    await advance({ ...opts, now: later(100 + 49) })
    expect(await phases()).toEqual({ [H1]: "retiring", [H2]: "active", [H3]: "spare" })
    expect((await activeDkimKey(domainId))?.selector).toBe("corsair-2")

    // The domain's required CNAME follows the signing selector.
    const records = await db().all<{ host: string; required: boolean }>(
      from(domainRecords)
        .select("host", "required")
        .where((q) => [q("domain_id").equals(domainId), q("purpose").equals("dkim")]),
    )
    expect(records.find((r) => r.host.startsWith("corsair-2"))?.required).toBe(true)
    expect(records.find((r) => r.host.startsWith("corsair-1"))?.required).toBe(false)

    // Retiring: kept for the full period, then revoked.
    await advance({ ...opts, now: later(100 + 49 + 24 * 6) })
    expect((await phases())[H1]).toBe("retiring")
    await advance({ ...opts, now: later(100 + 49 + 24 * 7 + 1) })
    expect((await phases())[H1]).toBe("revoked")
  })

  test("a revoked host publishes an empty p=", async () => {
    await startRotation(T0)
    await publishHost(H2)
    await publishDomain(1)
    const opts = { resolve, soakHours: 1, retireDays: 1 }
    await advance({ ...opts, now: later(1) })
    await advance({ ...opts, now: later(3) })
    await advance({ ...opts, now: later(30) })

    const h1 = (await ensureHosts()).find((h) => h.host === H1)!
    expect(h1.phase).toBe("revoked")
    expect(await expectedRecord(h1)).toBe(REVOKED_RECORD)
    expect(await expectedRecord(h1)).toMatch(/p=$/)
  })

  test("the next cycle reuses the revoked host with a new key", async () => {
    await startRotation(T0)
    await publishHost(H2)
    await publishDomain(1)
    const opts = { resolve, soakHours: 1, retireDays: 1 }
    await advance({ ...opts, now: later(1) })
    await advance({ ...opts, now: later(3) })
    await advance({ ...opts, now: later(30) })

    const old = (await keysOf(domainId))[0]!.public_key
    const next = await startRotation(later(31))
    expect(next.host).toBe(H3)
    // H3 was spare; a second cycle from H3 wraps to the revoked H1.
    await publishHost(H3)
    const k3 = (await keysOf(domainId))[2]!
    dns.set(`${k3.selector}._domainkey.${domainName}`, [dkimRecord(k3.public_key)])
    await advance({ ...opts, now: later(32) })
    await advance({ ...opts, now: later(34) })
    await advance({ ...opts, now: later(60) })
    const again = await startRotation(later(61))
    expect(again.host).toBe(H1)
    expect((await keysOf(domainId))[0]!.public_key).not.toBe(old)
  })
})

describe("refusing to activate without DNS", () => {
  test("a host record that is wrong keeps the host out of published", async () => {
    await startRotation(T0)
    await publishHost(H2, "v=DKIM1; k=rsa; p=QUJD")
    await advance({ resolve, now: later(500) })
    expect((await phases())[H2]).toBe("staged")
  })

  test("a record that vanishes during the soak drops back to staged", async () => {
    await startRotation(T0)
    await publishHost(H2)
    await advance({ resolve, now: later(1) })
    expect((await phases())[H2]).toBe("published")
    dns.delete(H2)
    await advance({ resolve, now: later(60) })
    expect((await phases())[H2]).toBe("staged")
    expect((await phases())[H1]).toBe("active")
  })

  test("a domain whose own selector does not resolve keeps its old key", async () => {
    await startRotation(T0)
    await publishHost(H2)
    await advance({ resolve, soakHours: 1, now: later(1) })
    await advance({ resolve, soakHours: 1, now: later(5) })
    expect((await phases())[H2]).toBe("active")

    // No CNAME for corsair-2 at the customer: still signing with selector 1.
    expect((await activeDkimKey(domainId))?.selector).toBe("corsair-1")

    // A CNAME that resolves to some other key is no better than none.
    dns.set(`corsair-2._domainkey.${domainName}`, ["v=DKIM1; k=rsa; p=QUJD"])
    await advance({ resolve, soakHours: 1, now: later(6) })
    expect((await activeDkimKey(domainId))?.selector).toBe("corsair-1")

    // And the old host is not revoked while something still signs with it.
    await advance({ resolve, retireDays: 1, now: later(24 * 30) })
    expect((await phases())[H1]).toBe("retiring")

    await publishDomain(1)
    await advance({ resolve, now: later(24 * 30 + 1) })
    expect((await activeDkimKey(domainId))?.selector).toBe("corsair-2")
  })

  test("keyResolves is the same check the manual activation endpoint uses", async () => {
    const key = (await keysOf(domainId))[1]!
    expect(await keyResolves(domainName, key, resolve)).toBe(false)
    await publishDomain(1)
    expect(await keyResolves(domainName, key, resolve)).toBe(true)
  })
})

describe("automatic start", () => {
  test("rotateDays 0 never starts a cycle", async () => {
    await advance({ resolve, rotateDays: 0, now: later(24 * 1000) })
    expect(await phases()).toEqual({ [H1]: "active", [H2]: "spare", [H3]: "spare" })
  })

  test("starts once the active key is older than rotateDays", async () => {
    await ensureHosts(T0)
    await advance({ resolve, rotateDays: 180, now: later(24 * 179) })
    expect((await phases())[H2]).toBe("spare")
    await advance({ resolve, rotateDays: 180, now: later(24 * 181) })
    expect((await phases())[H2]).toBe("staged")
  })
})

describe("new domains after a rotation", () => {
  test("sign with the active host and require its CNAME", async () => {
    await startRotation(T0)
    await publishHost(H2)
    await advance({ resolve, soakHours: 1, now: later(1) })
    await advance({ resolve, soakHours: 1, now: later(5) })

    const fresh = await createDomain({ userId: await makeUser(), name: `fresh-${suffix}.invalid` })
    expect((await activeDkimKey(fresh.domain.id))?.selector).toBe("corsair-2")
    const dkim = fresh.records.filter((r) => r.purpose === "dkim")
    expect(dkim.find((r) => r.host.startsWith("corsair-2"))?.required).toBe(true)
    expect(dkim.find((r) => r.host.startsWith("corsair-1"))?.required).toBe(false)
  })
})
