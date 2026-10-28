import { resolveTxt } from "node:dns/promises"
import { from } from "@wess/atlas/db/query"
import { config } from "../config/index.ts"
import { db, num } from "../db/index.ts"
import { dkimRecord, generateKeyPair } from "../dkim/index.ts"
import { syncRecords } from "../domains/index.ts"
import { type DkimHost, type Domain, dkimHosts } from "../schema/index.ts"

/**
 * DKIM key rotation for the selector hosts in `MAIL_DKIM_HOSTS`.
 *
 * Every customer CNAMEs `corsair-N._domainkey` to host N, and each host holds one
 * TXT record, so a key can only be replaced by moving signing to a *different*
 * selector. Rotation therefore alternates between hosts the customers already
 * point at, and the operator — who owns the zone those hosts live in — is the
 * only one who publishes anything. Customers touch nothing.
 *
 * A host walks: spare -> staged (new key minted, not seen in DNS) -> published
 * (seen, soaking so resolver caches expire) -> active (signs) -> retiring (old
 * key still published for in-flight mail) -> revoked (publish an empty `p=`,
 * RFC 6376 §3.6.1). Signing only ever moves to a key whose TXT was *resolved* and
 * matched, because anything else is a well-formed signature that fails at every
 * receiver and logs nothing.
 */

export type Resolver = (name: string) => Promise<string[]>

/** TXT strings for a name, each record's chunks joined. Throws on lookup failure. */
export const defaultResolver: Resolver = async (name) =>
  (await resolveTxt(name)).map((chunks) => chunks.join(""))

/** What a revoked selector publishes: a record whose key is deliberately empty. */
export const REVOKED_RECORD = "v=DKIM1; k=rsa; p="

export const PHASES = ["spare", "staged", "published", "active", "retiring", "revoked"] as const
export type Phase = (typeof PHASES)[number]

const tagsOf = (record: string): Record<string, string> => {
  const tags: Record<string, string> = {}
  for (const part of record.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    const name = part.slice(0, eq).trim().toLowerCase()
    if (name && !(name in tags)) tags[name] = part.slice(eq + 1).replace(/\s+/g, "")
  }
  return tags
}

/**
 * Whether what DNS returned carries the expected key. Compared on the `p=` tag
 * alone so whitespace, tag order and quoting differences do not matter, and an
 * expected empty `p=` matches only an empty one. Bun hands back each 255-byte
 * chunk as its own record, so the set is also tried concatenated.
 */
export const recordMatches = (found: string[], expected: string): boolean => {
  const want = tagsOf(expected).p ?? ""
  const isMatch = (record: string) => {
    const tags = tagsOf(record)
    return (tags.v ?? "DKIM1").toUpperCase() === "DKIM1" && (tags.p ?? "\0") === want
  }
  return found.some(isMatch) || (found.length > 1 && isMatch(found.join("")))
}

export type DnsState = "ok" | "missing" | "mismatch"

const dnsState = async (name: string, expected: string, resolve: Resolver): Promise<DnsState> => {
  let found: string[]
  try {
    found = await resolve(name)
  } catch {
    return "missing"
  }
  if (!found.length) return "missing"
  return recordMatches(found, expected) ? "ok" : "mismatch"
}

// state

const hostRows = async (): Promise<DkimHost[]> =>
  db().all<DkimHost>(from(dkimHosts).orderBy("position", "ASC"))

/**
 * Makes sure every configured host has a row. The first run on an existing
 * install adopts reality: the host most domains sign with is `active`, which is
 * hosts[0] unless someone activated another by hand.
 */
export const ensureHosts = async (now = new Date()): Promise<DkimHost[]> => {
  const rows = await hostRows()
  const known = new Set(rows.map((r) => r.host))
  const missing = config.mail.dkimHosts.filter((h) => !known.has(h))
  if (missing.length) {
    let active = rows.find((r) => r.phase === "active")?.host ?? null
    if (!active) {
      const top = await db().one<{ cname_target: string }>({
        text: `SELECT cname_target FROM dkim_keys WHERE active
                GROUP BY cname_target ORDER BY count(*) DESC LIMIT 1`,
        values: [],
      })
      active = top?.cname_target ?? config.mail.dkimHosts[0] ?? null
    }
    for (const host of missing) {
      await db().execute({
        text: `INSERT INTO dkim_hosts (host, position, phase, phase_at)
               VALUES ($1, $2, $3, $4) ON CONFLICT (host) DO NOTHING`,
        values: [
          host,
          config.mail.dkimHosts.indexOf(host),
          host === active ? "active" : "spare",
          now,
        ],
      })
    }
  }
  return missing.length ? hostRows() : rows
}

const setPhase = async (
  host: string,
  phase: Phase,
  now: Date,
  extra: { published_at?: Date | null } = {},
): Promise<void> => {
  await db().execute(
    from(dkimHosts)
      .where((q) => q("host").equals(host))
      .update({ phase, phase_at: now, ...extra }),
  )
}

/** The public key a host currently carries, taken from any domain's row for it. */
const keyOfHost = async (host: string): Promise<string | null> => {
  const row = await db().one<{ public_key: string }>({
    text: `SELECT public_key FROM dkim_keys WHERE cname_target = $1
            ORDER BY created_at ASC LIMIT 1`,
    values: [host],
  })
  return row?.public_key ?? null
}

/** The TXT value this host should be publishing in its current phase, if any. */
export const expectedRecord = async (host: DkimHost): Promise<string | null> => {
  if (host.phase === "revoked") return REVOKED_RECORD
  if (host.phase === "spare") return null
  const key = await keyOfHost(host.host)
  return key ? dkimRecord(key) : null
}

const signersOn = async (host: string): Promise<number> =>
  num(
    (
      await db().one<{ n: bigint }>({
        text: "SELECT count(*) AS n FROM dkim_keys WHERE active AND cname_target = $1",
        values: [host],
      })
    )?.n,
  )

// cycle

const IN_PROGRESS: Phase[] = ["staged", "published", "retiring"]

export const cycleInProgress = (hosts: DkimHost[]): boolean =>
  hosts.some((h) => IN_PROGRESS.includes(h.phase as Phase))

/**
 * Begins a rotation: picks the next host after the active one, mints a fresh
 * keypair into every domain's row for it, and parks it as `staged`. Nothing signs
 * with it until the operator has published the record and DNS has shown it.
 */
export const startRotation = async (
  now = new Date(),
): Promise<{ host: string; record: string }> => {
  const hosts = await ensureHosts(now)
  if (cycleInProgress(hosts)) throw new Error("a rotation is already in progress")
  const active = hosts.find((h) => h.phase === "active")
  if (!active) throw new Error("no active selector host")
  if (hosts.length < 2) throw new Error("rotation needs at least two MAIL_DKIM_HOSTS")

  const n = hosts.length
  const next = Array.from({ length: n - 1 }, (_, i) => hosts[(active.position + 1 + i) % n]).find(
    (h) => h && (h.phase === "spare" || h.phase === "revoked"),
  )
  if (!next) throw new Error("no spare selector host to rotate onto")
  if (await signersOn(next.host)) throw new Error(`a domain still signs with ${next.host}`)

  const pair = generateKeyPair()
  const updated = await db().all<{ id: string }>({
    text: `UPDATE dkim_keys SET private_key = $2, public_key = $3, created_at = now()
            WHERE cname_target = $1 RETURNING id`,
    values: [next.host, pair.privateKey, pair.publicKey],
  })
  if (!updated.length) throw new Error("no domain has a key for the next selector host yet")

  await setPhase(next.host, "staged", now, { published_at: null })
  return { host: next.host, record: pair.record }
}

export type AdvanceOptions = {
  now?: Date
  resolve?: Resolver
  rotateDays?: number
  soakHours?: number
  retireDays?: number
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

/**
 * Moves the rotation as far as DNS allows and reports what it did. Safe to call
 * as often as you like; every step is gated on an observation or a clock and a
 * call that has nothing to do changes nothing.
 */
export const advance = async (options: AdvanceOptions = {}): Promise<string[]> => {
  const now = options.now ?? new Date()
  const resolve = options.resolve ?? defaultResolver
  const rotateDays = options.rotateDays ?? config.dkim.rotateDays
  const soak = (options.soakHours ?? config.dkim.soakHours) * HOUR
  const retire = (options.retireDays ?? config.dkim.retireDays) * DAY
  const log: string[] = []

  let hosts = await ensureHosts(now)

  // staged -> published: the new TXT has to be visible at the host itself.
  for (const host of hosts.filter((h) => h.phase === "staged")) {
    const expected = await expectedRecord(host)
    if (!expected) {
      // Every domain that held the key is gone; nothing left to publish.
      await setPhase(host.host, "spare", now)
      log.push(`${host.host}: no key left, back to spare`)
      continue
    }
    if ((await dnsState(host.host, expected, resolve)) === "ok") {
      await setPhase(host.host, "published", now, { published_at: now })
      log.push(`${host.host}: new key seen in DNS, soaking ${config.dkim.soakHours}h`)
    }
  }
  hosts = await hostRows()

  // published -> active: after the soak, and only if it still resolves.
  for (const host of hosts.filter((h) => h.phase === "published")) {
    const expected = await expectedRecord(host)
    const state = expected ? await dnsState(host.host, expected, resolve) : "missing"
    if (state !== "ok") {
      await setPhase(host.host, "staged", now, { published_at: null })
      log.push(`${host.host}: record no longer resolves (${state}), back to staged`)
      continue
    }
    const since = host.published_at ?? host.phase_at
    if (now.getTime() - since.getTime() < soak) continue

    const old = hosts.find((h) => h.phase === "active")
    // One transaction: the unique index allows one active host, so the old one
    // has to step down in the same breath the new one steps up.
    await db().transaction(async (conn) => {
      if (old)
        await conn.execute({
          text: "UPDATE dkim_hosts SET phase = 'retiring', phase_at = $2 WHERE host = $1",
          values: [old.host, now],
        })
      await conn.execute({
        text: "UPDATE dkim_hosts SET phase = 'active', phase_at = $2 WHERE host = $1",
        values: [host.host, now],
      })
    })
    log.push(`${host.host}: active${old ? `, ${old.host} retiring` : ""}`)
  }
  hosts = await hostRows()

  // Domains move one at a time, each only once *its own* name resolves to the
  // new key through its own CNAME: a customer who never published selector N
  // keeps signing with the old key.
  const active = hosts.find((h) => h.phase === "active")
  if (active) log.push(...(await moveDomains(active, resolve, now)))

  // retiring -> revoked, once the clock has run and nothing signs with it.
  for (const host of hosts.filter((h) => h.phase === "retiring")) {
    if (now.getTime() - host.phase_at.getTime() < retire) continue
    if (await signersOn(host.host)) continue
    await setPhase(host.host, "revoked", now)
    log.push(`${host.host}: revoked, publish an empty p=`)
  }
  hosts = await hostRows()

  const current = hosts.find((h) => h.phase === "active")
  if (
    rotateDays > 0 &&
    current &&
    !cycleInProgress(hosts) &&
    now.getTime() - current.phase_at.getTime() >= rotateDays * DAY
  ) {
    try {
      const started = await startRotation(now)
      log.push(`${started.host}: staged, publish its TXT record`)
    } catch (e) {
      log.push(`rotation not started: ${(e as Error).message}`)
    }
  }

  return log
}

// Domains signing with a host other than `$1`, paired with their key for `$1`.
const MOVERS = `SELECT d.id AS domain_id, d.name, o.id AS old_id, n.id AS new_id,
                       n.selector AS new_selector, n.public_key AS new_public
                  FROM dkim_keys o
                  JOIN domains d ON d.id = o.domain_id
                  JOIN dkim_keys n ON n.domain_id = o.domain_id AND n.cname_target = $1
                 WHERE o.active AND o.cname_target <> $1`

type Mover = {
  domain_id: string
  name: string
  old_id: string
  new_id: string
  new_selector: string
  new_public: string
}

const moveDomains = async (active: DkimHost, resolve: Resolver, now: Date): Promise<string[]> => {
  const candidates = await db().all<Mover>({
    text: MOVERS,
    values: [active.host],
  })

  const log: string[] = []
  for (const c of candidates) {
    const state = await dnsState(
      `${c.new_selector}._domainkey.${c.name}`,
      dkimRecord(c.new_public),
      resolve,
    )
    if (state !== "ok") continue
    await db().transaction(async (conn) => {
      await conn.execute({
        text: "UPDATE dkim_keys SET active = false WHERE id = $1",
        values: [c.old_id],
      })
      await conn.execute({
        text: "UPDATE dkim_keys SET active = true, rotated_at = $2 WHERE id = $1",
        values: [c.new_id, now],
      })
    })
    const domain = await db().one<Domain>({
      text: "SELECT * FROM domains WHERE id = $1",
      values: [c.domain_id],
    })
    // The required DKIM CNAME follows the signing selector.
    if (domain) await syncRecords(domain)
    log.push(`${c.name}: now signs with ${c.new_selector}`)
  }
  return log
}

/**
 * Whether a domain's name for this key resolves to it right now. The manual
 * activation endpoint uses it so a customer cannot do by hand what the worker
 * refuses to do.
 */
export const keyResolves = async (
  domainName: string,
  key: { selector: string; public_key: string },
  resolve: Resolver = defaultResolver,
): Promise<boolean> =>
  (await dnsState(
    `${key.selector}._domainkey.${domainName}`,
    dkimRecord(key.public_key),
    resolve,
  )) === "ok"

// reporting

export type HostStatus = {
  host: string
  selector: string
  phase: Phase
  since: Date
  record: string | null
  dns: DnsState | null
  signers: number
  /** What the operator has to do for this host, or null. */
  action: string | null
}

const chunked = (record: string): string =>
  (record.match(/.{1,255}/g) ?? []).map((c) => `"${c}"`).join(" ")

export const status = async (resolve: Resolver = defaultResolver): Promise<HostStatus[]> => {
  const hosts = await ensureHosts()
  const out: HostStatus[] = []
  for (const host of hosts) {
    const record = await expectedRecord(host)
    const dns = record ? await dnsState(host.host, record, resolve) : null
    const signers = await signersOn(host.host)

    let action: string | null = null
    if (record && dns !== "ok") {
      action = `publish at ${host.host}: TXT ${chunked(record)}`
    } else if (host.phase === "staged") {
      action = "waiting for the worker to see the record"
    } else if (host.phase === "retiring") {
      action = `keep published; ${signers} domain(s) still sign with it`
    }
    out.push({
      host: host.host,
      selector: `corsair-${host.position + 1}`,
      phase: host.phase as Phase,
      since: host.phase_at,
      record,
      dns,
      signers,
      action,
    })
  }
  return out
}

/** Domains still signing with a host other than the active one, and why. */
export const stragglers = async (
  resolve: Resolver = defaultResolver,
): Promise<{ domain: string; selector: string; dns: DnsState }[]> => {
  const hosts = await ensureHosts()
  const active = hosts.find((h) => h.phase === "active")
  if (!active) return []
  const rows = await db().all<Mover>({
    text: MOVERS,
    values: [active.host],
  })
  const out = []
  for (const r of rows)
    out.push({
      domain: r.name,
      selector: r.new_selector,
      dns: await dnsState(
        `${r.new_selector}._domainkey.${r.name}`,
        dkimRecord(r.new_public),
        resolve,
      ),
    })
  return out
}
