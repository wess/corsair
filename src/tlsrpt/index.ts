import { isIP } from "node:net"
import { stripControls } from "../mime/index.ts"
import type { TlsFailure } from "../schema/index.ts"

/**
 * SMTP TLS reports, RFC 8460: the JSON format, read and written.
 *
 * As with DMARC, everything read is untrusted and bounded. A policy entry whose
 * domain or counts do not parse is dropped; a report with no usable policy is
 * refused.
 */

export type TlsPolicyEntry = {
  policyType: string
  policyDomain: string
  mxHost: string | null
  success: number
  failure: number
  failures: TlsFailure[]
}

export type TlsReportDoc = {
  orgName: string
  reportId: string
  contact: string | null
  begin: Date
  end: Date
  policies: TlsPolicyEntry[]
}

const MAX_POLICIES = 200
const MAX_FAILURES = 100

type Json = Record<string, unknown>

const obj = (v: unknown): Json | null =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null

const str = (v: unknown, max = 255): string | null => {
  if (typeof v !== "string") return null
  const out = stripControls(v).trim().slice(0, max)
  return out || null
}

const count = (v: unknown): number | null =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000 ? v : null

const domainOf = (v: unknown): string | null => {
  const d = str(v, 253)?.toLowerCase().replace(/\.$/, "") ?? null
  return d && /^[a-z0-9._*-]+$/.test(d) ? d : null
}

const dateOf = (v: unknown): Date | null => {
  const s = str(v, 64)
  if (!s) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

const ipOf = (v: unknown): string | null => {
  const s = str(v, 64)
  return s && isIP(s) !== 0 ? s : null
}

export const parseTlsReport = (json: string): TlsReportDoc => {
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new Error("TLS report is not valid JSON.")
  }
  const root = obj(data)
  const range = obj(root?.["date-range"])
  const orgName = str(root?.["organization-name"])
  const reportId = str(root?.["report-id"])
  const begin = dateOf(range?.["start-datetime"])
  const end = dateOf(range?.["end-datetime"])
  if (!root || !orgName || !reportId || !begin || !end)
    throw new Error("TLS report is missing its organization-name, report-id or date-range.")

  const policies: TlsPolicyEntry[] = []
  const list = Array.isArray(root.policies) ? root.policies : []
  for (const raw of list.slice(0, MAX_POLICIES)) {
    const entry = obj(raw)
    const policy = obj(entry?.policy)
    const summary = obj(entry?.summary)
    const policyDomain = domainOf(policy?.["policy-domain"])
    const success = count(summary?.["total-successful-session-count"])
    const failure = count(summary?.["total-failure-session-count"])
    if (!policyDomain || success === null || failure === null) continue

    // `mx-host` is a list in RFC 8460; some senders write a bare string.
    const mx = policy?.["mx-host"]
    const mxHost = Array.isArray(mx)
      ? mx
          .map((m) => str(m, 253))
          .filter(Boolean)
          .slice(0, 10)
          .join(", ") || null
      : str(mx, 253)

    const details = Array.isArray(entry?.["failure-details"]) ? entry["failure-details"] : []
    const failures: TlsFailure[] = []
    for (const d of (details as unknown[]).slice(0, MAX_FAILURES)) {
      const f = obj(d)
      const resultType = str(f?.["result-type"], 64)
      if (!f || !resultType) continue
      failures.push({
        result_type: resultType,
        sending_mta_ip: ipOf(f["sending-mta-ip"]),
        receiving_mx_hostname: domainOf(f["receiving-mx-hostname"]),
        receiving_ip: ipOf(f["receiving-ip"]),
        failed_session_count: count(f["failed-session-count"]) ?? 0,
        failure_reason_code: str(f["failure-reason-code"]),
      })
    }

    policies.push({
      policyType: str(policy?.["policy-type"], 32) ?? "no-policy-found",
      policyDomain,
      mxHost,
      success,
      failure,
      failures,
    })
  }
  if (!policies.length) throw new Error("TLS report has no usable policy entries.")

  return { orgName, reportId, contact: str(root["contact-info"]), begin, end, policies }
}

// build

export type OutboundTlsRow = { mx_host: string; result: string; detail: string; count: number }

/**
 * One day's sessions to one recipient domain, as an RFC 8460 report.
 *
 * The policy type is always `no-policy-found`. The outbound client applies
 * opportunistic STARTTLS and neither MTA-STS nor DANE, so there is no policy
 * whose outcome it could honestly report on; what it *can* say is how many
 * sessions negotiated TLS and why the others did not.
 */
export const buildTlsReport = (input: {
  orgName: string
  contact: string
  reportId: string
  begin: Date
  end: Date
  policyDomain: string
  rows: OutboundTlsRow[]
}): string => {
  const success = input.rows
    .filter((r) => r.result === "success")
    .reduce((sum, r) => sum + r.count, 0)
  const failed = input.rows.filter((r) => r.result !== "success")
  const mxHosts = [...new Set(input.rows.map((r) => r.mx_host))]
  return JSON.stringify({
    "organization-name": input.orgName,
    "date-range": {
      "start-datetime": input.begin.toISOString().replace(/\.\d{3}Z$/, "Z"),
      "end-datetime": input.end.toISOString().replace(/\.\d{3}Z$/, "Z"),
    },
    "contact-info": input.contact,
    "report-id": input.reportId,
    policies: [
      {
        policy: {
          "policy-type": "no-policy-found",
          "policy-domain": input.policyDomain,
          "mx-host": mxHosts,
        },
        summary: {
          "total-successful-session-count": success,
          "total-failure-session-count": failed.reduce((sum, r) => sum + r.count, 0),
        },
        "failure-details": failed.map((r) => ({
          "result-type": r.result,
          "receiving-mx-hostname": r.mx_host,
          "failed-session-count": r.count,
          ...(r.detail ? { "failure-reason-code": r.detail } : {}),
        })),
      },
    ],
  })
}
