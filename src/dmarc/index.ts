import { isIP } from "node:net"
import { stripControls } from "../mime/index.ts"
import type { DmarcAuthResult } from "../schema/index.ts"
import { child, childrenNamed, parseXml, renderXml, textOf, type XmlTree } from "../xml/index.ts"

/**
 * DMARC aggregate reports, RFC 7489 §7.2 and the schema in its appendix C.
 *
 * Parsing is for reports other receivers send about our customers' domains;
 * building is for the reports this server sends about everyone else's. Every
 * value read is untrusted: strings are bounded and stripped of controls, IPs
 * must parse, counts must be non-negative integers, and a record that fails
 * any of that is dropped rather than stored as whatever it claimed.
 */

export type DmarcDisposition = "none" | "quarantine" | "reject"

export type AggregateRecord = {
  sourceIp: string
  count: number
  disposition: string
  dkimEval: string
  spfEval: string
  headerFrom: string
  envelopeFrom: string | null
  dkim: DmarcAuthResult[]
  spf: DmarcAuthResult[]
}

export type AggregatePolicy = {
  domain: string
  p: string | null
  sp: string | null
  pct: number | null
  adkim: string | null
  aspf: string | null
}

export type AggregateReport = {
  orgName: string
  email: string | null
  reportId: string
  begin: Date
  end: Date
  policy: AggregatePolicy
  records: AggregateRecord[]
}

/** More records than any real day produces; a report past it is truncated, not refused. */
export const MAX_RECORDS = 5000

const clean = (value: string | null, max = 255): string | null => {
  if (value === null) return null
  const out = stripControls(value).trim().slice(0, max)
  return out || null
}

const lowerDomain = (value: string | null): string | null => {
  const v = clean(value, 253)?.toLowerCase().replace(/\.$/, "") ?? null
  return v && /^[a-z0-9._-]+$/.test(v) ? v : null
}

const intOf = (value: string | null, max = 1_000_000_000): number | null => {
  if (value === null || !/^\d{1,12}$/.test(value)) return null
  const n = Number(value)
  return n <= max ? n : null
}

const oneOf = <T extends string>(value: string | null, allowed: readonly T[]): T | null => {
  const v = value?.toLowerCase() ?? null
  return v && (allowed as readonly string[]).includes(v) ? (v as T) : null
}

const RESULTS = ["none", "pass", "fail", "softfail", "neutral", "temperror", "permerror", "policy"]

export const parseAggregate = (xml: string, maxRecords = MAX_RECORDS): AggregateReport => {
  const doc = parseXml(xml)
  const feedback = child(doc, "feedback")
  if (!feedback) throw new Error("Not a DMARC aggregate report: no <feedback> element.")

  const meta = child(feedback, "report_metadata")
  const range = child(meta, "date_range")
  const published = child(feedback, "policy_published")

  const orgName = clean(textOf(meta, "org_name"))
  const reportId = clean(textOf(meta, "report_id"))
  const begin = intOf(textOf(range, "begin"), 4_102_444_800)
  const end = intOf(textOf(range, "end"), 4_102_444_800)
  const domain = lowerDomain(textOf(published, "domain"))
  if (!orgName || !reportId || begin === null || end === null || !domain)
    throw new Error("DMARC report is missing its org_name, report_id, date_range or domain.")
  if (end < begin) throw new Error("DMARC report's date range ends before it begins.")

  const policies = ["none", "quarantine", "reject"] as const
  const policy: AggregatePolicy = {
    domain,
    p: oneOf(textOf(published, "p"), policies),
    sp: oneOf(textOf(published, "sp"), policies),
    pct: intOf(textOf(published, "pct"), 100),
    adkim: oneOf(textOf(published, "adkim"), ["r", "s"] as const),
    aspf: oneOf(textOf(published, "aspf"), ["r", "s"] as const),
  }

  const records: AggregateRecord[] = []
  for (const record of childrenNamed(feedback, "record")) {
    if (records.length >= maxRecords) break
    const row = child(record, "row")
    const evaluated = child(row, "policy_evaluated")
    const ids = child(record, "identifiers")
    const auth = child(record, "auth_results")

    const sourceIp = clean(textOf(row, "source_ip"), 64)
    const count = intOf(textOf(row, "count"))
    const headerFrom = lowerDomain(textOf(ids, "header_from"))
    if (!sourceIp || isIP(sourceIp) === 0 || count === null || !headerFrom) continue

    const results = (name: "dkim" | "spf"): DmarcAuthResult[] =>
      childrenNamed(auth, name)
        .slice(0, 20)
        .flatMap((r) => {
          const d = lowerDomain(textOf(r, "domain"))
          const result = oneOf(textOf(r, "result"), RESULTS)
          if (!d || !result) return []
          const extra =
            name === "dkim" ? clean(textOf(r, "selector"), 63) : clean(textOf(r, "scope"), 8)
          return [
            {
              domain: d,
              result,
              ...(extra ? (name === "dkim" ? { selector: extra } : { scope: extra }) : {}),
            },
          ]
        })

    records.push({
      sourceIp,
      count,
      disposition: oneOf(textOf(evaluated, "disposition"), policies) ?? "none",
      dkimEval: oneOf(textOf(evaluated, "dkim"), ["pass", "fail"] as const) ?? "fail",
      spfEval: oneOf(textOf(evaluated, "spf"), ["pass", "fail"] as const) ?? "fail",
      headerFrom,
      envelopeFrom: lowerDomain(textOf(ids, "envelope_from")),
      dkim: results("dkim"),
      spf: results("spf"),
    })
  }

  return {
    orgName,
    email: clean(textOf(meta, "email")),
    reportId,
    begin: new Date(begin * 1000),
    end: new Date(end * 1000),
    policy,
    records,
  }
}

/** DMARC passes for a record when either aligned identifier passed. */
export const recordPassed = (r: Pick<AggregateRecord, "dkimEval" | "spfEval">): boolean =>
  r.dkimEval === "pass" || r.spfEval === "pass"

// build

export type OutboundRow = {
  source_ip: string
  count: number
  disposition: string
  header_from: string
  envelope_from: string
  spf_result: string
  spf_domain: string
  spf_aligned: boolean
  dkim_result: string
  dkim_domain: string
  dkim_aligned: boolean
}

export const buildAggregate = (input: {
  orgName: string
  email: string
  reportId: string
  begin: Date
  end: Date
  policy: AggregatePolicy
  rows: OutboundRow[]
}): string => {
  const seconds = (d: Date) => Math.floor(d.getTime() / 1000)
  const tree: XmlTree = [
    ["version", "1.0"],
    [
      "report_metadata",
      [
        ["org_name", input.orgName],
        ["email", input.email],
        ["report_id", input.reportId],
        [
          "date_range",
          [
            ["begin", seconds(input.begin)],
            ["end", seconds(input.end)],
          ],
        ],
      ],
    ],
    [
      "policy_published",
      [
        ["domain", input.policy.domain],
        ["adkim", input.policy.adkim ?? "r"],
        ["aspf", input.policy.aspf ?? "r"],
        ["p", input.policy.p ?? "none"],
        ["sp", input.policy.sp ?? input.policy.p ?? "none"],
        ["pct", input.policy.pct ?? 100],
      ],
    ],
  ]

  for (const row of input.rows) {
    const dkimPass = row.dkim_aligned && row.dkim_result === "pass"
    const spfPass = row.spf_aligned && row.spf_result === "pass"
    const auth: XmlTree = []
    if (row.dkim_domain) {
      auth.push([
        "dkim",
        [
          ["domain", row.dkim_domain],
          ["result", row.dkim_result],
        ],
      ])
    }
    // The schema requires an SPF result on every record, even an empty one.
    auth.push([
      "spf",
      [
        ["domain", row.spf_domain || row.header_from],
        ["scope", "mfrom"],
        ["result", row.spf_result],
      ],
    ])
    tree.push([
      "record",
      [
        [
          "row",
          [
            ["source_ip", row.source_ip],
            ["count", row.count],
            [
              "policy_evaluated",
              [
                ["disposition", row.disposition],
                ["dkim", dkimPass ? "pass" : "fail"],
                ["spf", spfPass ? "pass" : "fail"],
              ],
            ],
          ],
        ],
        [
          "identifiers",
          [
            ["envelope_from", row.envelope_from || null],
            ["header_from", row.header_from],
          ],
        ],
        ["auth_results", auth],
      ],
    ])
  }

  return `<?xml version="1.0" encoding="UTF-8"?>\n<feedback>\n${renderXml(tree, 1)}\n</feedback>\n`
}
