import { resolveCname, resolveMx, resolveTxt } from "node:dns/promises"
import { from } from "@atlas/db"
import { config } from "../config/index.ts"
import { allColumns, db } from "../db/index.ts"
import { generateKeyPair } from "../dkim/index.ts"
import { conflict, invalidParameter } from "../errors/index.ts"
import { verificationToken } from "../ids/index.ts"
import {
  type DkimKey,
  type Domain,
  type DomainRecord,
  dkimKeys,
  domainRecords,
  domains,
} from "../schema/index.ts"

// Deliberately permissive on the TLD: new ones appear constantly and rejecting
// an unknown one is a support ticket, not a security control.
const DOMAIN_PATTERN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export const normalizeDomain = (input: string): string => {
  const trimmed = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "")
  if (!DOMAIN_PATTERN.test(trimmed))
    throw invalidParameter(`"${input}" is not a valid domain name.`)
  return trimmed
}

// -------------------------------------------------------------- provision --

export type RecordSpec = {
  purpose: string
  type: string
  host: string
  value: string
  priority: number | null
  required: boolean
  position: number
}

/**
 * The records a customer has to publish.
 *
 * DKIM is published as three CNAMEs rather than three TXT records on purpose: a
 * 2048-bit key does not fit in one TXT string, half of the DNS UIs in the world
 * mangle the chunked form, and a CNAME lets the key be rotated here without the
 * customer touching anything.
 */
export const recordSpec = (input: {
  domain: string
  verificationToken: string
  dkim: { selector: string; target: string }[]
  dmarcPolicy?: string
}): RecordSpec[] => {
  const rows: RecordSpec[] = [
    {
      purpose: "verification",
      type: "TXT",
      host: "@",
      value: input.verificationToken,
      priority: null,
      required: true,
      position: 0,
    },
    {
      purpose: "spf",
      type: "TXT",
      host: "@",
      value: `v=spf1 include:${config.mail.spf} -all`,
      priority: null,
      required: true,
      position: 1,
    },
    {
      purpose: "dmarc",
      type: "TXT",
      host: "_dmarc",
      value: `v=DMARC1; p=${input.dmarcPolicy ?? "quarantine"};`,
      priority: null,
      required: true,
      position: 2,
    },
  ]

  input.dkim.forEach((key, index) => {
    rows.push({
      purpose: "dkim",
      type: "CNAME",
      host: `${key.selector}._domainkey`,
      value: key.target,
      // Only the first selector has to exist; the spares are for rotation and a
      // domain should not sit unverified because the customer added one CNAME.
      priority: null,
      required: index === 0,
      position: 3 + index,
    })
  })

  rows.push(
    {
      purpose: "mta_sts",
      type: "CNAME",
      host: "mta-sts",
      value: config.mail.smtp,
      priority: null,
      required: false,
      position: 10,
    },
    {
      purpose: "autoconfig",
      type: "CNAME",
      host: "autoconfig",
      value: config.mail.autoconfig,
      priority: null,
      required: false,
      position: 11,
    },
    {
      purpose: "autodiscover",
      type: "CNAME",
      host: "autodiscover",
      value: config.mail.autodiscover,
      priority: null,
      required: false,
      position: 12,
    },
    {
      purpose: "mx",
      type: "MX",
      host: "@",
      value: config.mail.mx,
      priority: 10,
      required: true,
      position: 13,
    },
  )

  return rows
}

/**
 * The keypair already in use for a selector host, if any domain has one.
 *
 * Ordered by creation so every later domain adopts the first one minted, which
 * is the one whose public half is published. Returns null on a host nothing has
 * used yet, and the caller generates.
 */
const keyPairFor = async (
  target: string,
): Promise<{ privateKey: string; publicKey: string } | null> => {
  const existing = await db().one<DkimKey>(
    from(dkimKeys)
      .where((q) => q("cname_target").equals(target))
      .orderBy("created_at", "ASC")
      .limit(1),
  )
  return existing ? { privateKey: existing.private_key, publicKey: existing.public_key } : null
}

export const createDomain = async (input: {
  userId: string
  name: string
  dmarcPolicy?: string
}): Promise<{ domain: Domain; records: DomainRecord[]; keys: DkimKey[] }> => {
  const name = normalizeDomain(input.name)

  const existing = await db().one<{ id: string }>(
    from(domains)
      .select("id")
      .where((q) => q("name").equals(name)),
  )
  if (existing) throw conflict(`${name} is already hosted on this server.`)

  const token = verificationToken()
  const domain = (await db().one<Domain>(
    from(domains)
      .insert({
        user_id: input.userId,
        name,
        verification_token: token,
        dmarc_policy: input.dmarcPolicy ?? "quarantine",
      })
      .returning(...allColumns(domains)),
  ))!

  /**
   * One key per selector *host*, shared by every domain on the installation.
   *
   * A customer publishes `corsair-1._domainkey.<their domain>` as a CNAME to
   * `dkimHosts[0]` — one name, in this server's zone, holding one TXT record.
   * Minting a fresh keypair per domain therefore produces keys that can never
   * all be published: the second domain overwrites the first, or more often
   * nothing is republished at all and the mismatch is invisible until a
   * receiver checks. The signature is well-formed, the record parses, and
   * verification fails everywhere with nothing in the logs to say why.
   *
   * This installation had exactly that: three selectors whose private keys
   * matched no published record, so every outbound message failed DKIM.
   *
   * The private key is shared across domains, which sounds worse than it is —
   * one server already holds all of them, so the blast radius of a compromise
   * does not change. `tests/dkimkeys.test.ts` pins the invariant.
   */
  const keys: DkimKey[] = []
  for (const [index, target] of config.mail.dkimHosts.entries()) {
    const pair = (await keyPairFor(target)) ?? generateKeyPair()
    const row = await db().one<DkimKey>(
      from(dkimKeys)
        .insert({
          domain_id: domain.id,
          selector: `corsair-${index + 1}`,
          cname_target: target,
          private_key: pair.privateKey,
          public_key: pair.publicKey,
          active: index === 0,
          position: index,
        })
        .returning(...allColumns(dkimKeys)),
    )
    if (row) keys.push(row)
  }

  const records = await syncRecords(domain, keys)
  return { domain, records, keys }
}

/**
 * Rewrites the expected-record rows for a domain. Called on creation and again
 * whenever something that changes the expected values moves — the DMARC policy,
 * or this installation's own hostnames.
 */
export const syncRecords = async (domain: Domain, keys?: DkimKey[]): Promise<DomainRecord[]> => {
  const dkim =
    keys ??
    (await db().all<DkimKey>(
      from(dkimKeys)
        .where((q) => q("domain_id").equals(domain.id))
        .orderBy("position", "ASC"),
    ))

  const spec = recordSpec({
    domain: domain.name,
    verificationToken: domain.verification_token,
    dkim: dkim.map((k) => ({ selector: k.selector, target: k.cname_target })),
    dmarcPolicy: domain.dmarc_policy,
  })

  const existing = await db().all<DomainRecord>(
    from(domainRecords).where((q) => q("domain_id").equals(domain.id)),
  )
  const byPurpose = new Map(existing.map((r) => [`${r.purpose}:${r.host}`, r]))

  const out: DomainRecord[] = []
  for (const row of spec) {
    const key = `${row.purpose}:${row.host}`
    const prior = byPurpose.get(key)
    if (prior) {
      byPurpose.delete(key)
      // Changing the expected value invalidates whatever we last observed.
      const changed = prior.value !== row.value || prior.type !== row.type
      const updated = await db().one<DomainRecord>(
        from(domainRecords)
          .where((q) => q("id").equals(prior.id))
          .update({
            type: row.type,
            value: row.value,
            priority: row.priority,
            required: row.required,
            position: row.position,
            ...(changed ? { status: "pending", observed: null, checked_at: null } : {}),
          })
          .returning(...allColumns(domainRecords)),
      )
      if (updated) out.push(updated)
      continue
    }
    const inserted = await db().one<DomainRecord>(
      from(domainRecords)
        .insert({ domain_id: domain.id, ...row })
        .returning(...allColumns(domainRecords)),
    )
    if (inserted) out.push(inserted)
  }

  // Anything the spec no longer describes.
  for (const stale of byPurpose.values()) {
    await db().execute(
      from(domainRecords)
        .where((q) => q("id").equals(stale.id))
        .del(),
    )
  }

  return out.sort((a, b) => a.position - b.position)
}

// ------------------------------------------------------------------ check --

const fqdn = (host: string, domain: string): string =>
  host === "@" || host === "" ? domain : `${host}.${domain}`

const normalizeCname = (value: string): string => value.replace(/\.$/, "").toLowerCase()

type Observation = { status: DomainRecord["status"]; observed: string | null }

const observe = async (record: DomainRecord, domain: Domain): Promise<Observation> => {
  const name = fqdn(record.host, domain.name)
  try {
    switch (record.type) {
      case "TXT": {
        const values = (await resolveTxt(name)).map((chunks) => chunks.join(""))
        if (!values.length) return { status: "missing", observed: null }
        // SPF and DMARC are compared by prefix — a customer is allowed to add
        // their own includes, and demanding a byte-for-byte match would fail
        // every domain that sends through anything else as well.
        const wanted = record.value.trim()
        const prefix =
          record.purpose === "spf" ? "v=spf1" : record.purpose === "dmarc" ? "v=DMARC1" : null

        if (prefix) {
          const candidate = values.find((v) =>
            v.trim().toLowerCase().startsWith(prefix.toLowerCase()),
          )
          if (!candidate) return { status: "missing", observed: values.join(" | ") }
          if (record.purpose === "spf") {
            const ok = candidate.toLowerCase().includes(`include:${config.mail.spf.toLowerCase()}`)
            return { status: ok ? "ok" : "mismatch", observed: candidate }
          }
          return { status: "ok", observed: candidate }
        }

        const exact = values.find((v) => v.trim() === wanted)
        return exact
          ? { status: "ok", observed: exact }
          : { status: "mismatch", observed: values.join(" | ") }
      }

      case "CNAME": {
        const values = await resolveCname(name)
        if (!values.length) return { status: "missing", observed: null }
        const ok = values.some((v) => normalizeCname(v) === normalizeCname(record.value))
        return { status: ok ? "ok" : "mismatch", observed: values.join(" | ") }
      }

      case "MX": {
        const values = await resolveMx(name)
        if (!values.length) return { status: "missing", observed: null }
        const ok = values.some((v) => normalizeCname(v.exchange) === normalizeCname(record.value))
        const observed = values.map((v) => `${v.priority} ${v.exchange}`).join(" | ")
        return { status: ok ? "ok" : "mismatch", observed }
      }

      default:
        return { status: "pending", observed: null }
    }
  } catch (e) {
    const code = (e as { code?: string }).code
    // NXDOMAIN and an empty answer both mean "not published yet", which is a
    // different thing from the resolver being broken.
    if (code === "ENOTFOUND" || code === "ENODATA") return { status: "missing", observed: null }
    return { status: "pending", observed: `lookup failed: ${code ?? "unknown"}` }
  }
}

export type CheckResult = {
  domain: Domain
  records: DomainRecord[]
  ready: boolean
}

/**
 * Re-checks every expected record and flips the domain to active once all the
 * required ones pass. A domain that was active and now fails goes back to
 * pending rather than failed: DNS breaks transiently, and `failed` should mean
 * somebody has to look at it.
 */
export const checkDomain = async (domain: Domain): Promise<CheckResult> => {
  const records = await db().all<DomainRecord>(
    from(domainRecords)
      .where((q) => q("domain_id").equals(domain.id))
      .orderBy("position", "ASC"),
  )

  const now = new Date()
  const checked: DomainRecord[] = []
  for (const record of records) {
    const { status, observed } = await observe(record, domain)
    const updated = await db().one<DomainRecord>(
      from(domainRecords)
        .where((q) => q("id").equals(record.id))
        .update({ status, observed, checked_at: now })
        .returning(...allColumns(domainRecords)),
    )
    checked.push(updated ?? { ...record, status, observed, checked_at: now })
  }

  const ready = checked.filter((r) => r.required).every((r) => r.status === "ok")
  const status = ready ? "active" : "pending"

  const saved = await db().one<Domain>(
    from(domains)
      .where((q) => q("id").equals(domain.id))
      .update({
        status,
        last_checked_at: now,
        ...(ready && !domain.verified_at ? { verified_at: now } : {}),
        updated_at: now,
      })
      .returning(...allColumns(domains)),
  )

  return { domain: saved ?? domain, records: checked, ready }
}

/** The signing key to use for a domain right now. */
export const activeDkimKey = async (domainId: string): Promise<DkimKey | null> =>
  db().one<DkimKey>(
    from(dkimKeys).where((q) => [q("domain_id").equals(domainId), q("active").equals(true)]),
  )

/**
 * The zone file a customer can hand to a provider that imports one. Emitted
 * with the domain's own origin so it pastes in without editing.
 */
export const zoneFile = (domain: Domain, records: DomainRecord[]): string => {
  const lines = [
    `; Corsair DNS records for ${domain.name}`,
    `$ORIGIN ${domain.name}.`,
    "$TTL 3600",
    "",
  ]
  for (const r of records) {
    const host = r.host === "@" ? "@" : r.host
    const value =
      r.type === "TXT"
        ? `"${r.value.replace(/"/g, '\\"')}"`
        : r.type === "MX"
          ? `${r.priority ?? 10} ${r.value}.`
          : `${r.value}.`
    lines.push(`${host}\t3600\tIN\t${r.type}\t${value}`)
  }
  return `${lines.join("\n")}\n`
}
