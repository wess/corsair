import { from } from "@wess/atlas/db/query"
import { unpack } from "../archive/index.ts"
import { db } from "../db/index.ts"
import { type AggregateReport, parseAggregate, recordPassed } from "../dmarc/index.ts"
import * as mime from "../mime/index.ts"
import { type DmarcReport, type Domain, domains, type TlsReport } from "../schema/index.ts"
import { parseTlsReport, type TlsReportDoc } from "../tlsrpt/index.ts"

/**
 * DMARC aggregate and TLS reports arriving for a hosted domain.
 *
 * A domain points `rua=mailto:` at one of two well-known local parts on itself,
 * `dmarc-reports@` or `tlsrpt@`. Well-known rather than a per-domain setting
 * because it needs nothing configured: the DNS records this server recommends
 * already name them, so reports start arriving the moment the record is
 * published, and there is no setting to get out of step with the record.
 *
 * The report is parsed *in addition to* normal routing, at the same seam as the
 * sending API's bounce address — checked per recipient ahead of
 * `resolveRecipient`. If a mailbox, alias, or catch-all answers for the address
 * the message is delivered there as well; if nothing does, the address is still
 * accepted at RCPT and the parse is the only thing that happens to it. Either
 * kind of report is accepted at either address, since what a message contains
 * is decided by reading it, not by where it was sent.
 */

export const REPORT_LOCAL_PARTS = ["dmarc-reports", "tlsrpt"] as const

/** Reports stored per domain per UTC day, past which the rest are dropped. */
const DAILY_REPORT_CAP = 500

/** The hosted domain a report address belongs to, or null if it is not one. */
export const reportTarget = async (address: string): Promise<Domain | null> => {
  const at = address.lastIndexOf("@")
  if (at <= 0) return null
  const local = address.slice(0, at).toLowerCase()
  if (!(REPORT_LOCAL_PARTS as readonly string[]).includes(local)) return null
  return db().one<Domain>(
    from(domains).where((q) => q("name").equals(address.slice(at + 1).toLowerCase())),
  )
}

/**
 * Whether a report may describe this domain: the domain itself or a subdomain
 * of it. This is what stops one customer filling another's tables — a report
 * mailed to `dmarc-reports@a.example` about `b.example` is about somebody else.
 */
export const coversDomain = (reportDomain: string, hosted: string): boolean => {
  const a = reportDomain.toLowerCase()
  const b = hosted.toLowerCase()
  return a === b || a.endsWith(`.${b}`)
}

// extract

const REPORT_TYPES = new Set([
  "application/zip",
  "application/x-zip",
  "application/x-zip-compressed",
  "application/gzip",
  "application/x-gzip",
  "application/octet-stream",
  "application/xml",
  "text/xml",
  "application/json",
  "application/tlsrpt+gzip",
  "application/tlsrpt+json",
])

/** The decoded payload of every part that could be a report, unpacked. */
export const reportPayloads = (raw: string, parsed: mime.ParsedMessage): string[] => {
  const out: string[] = []
  mime.walk(parsed.root, (part) => {
    if (part.type === "multipart" || out.length >= 4) return
    if (!REPORT_TYPES.has(`${part.type}/${part.subtype}`)) return
    const bytes = mime.decodeTransfer(raw.slice(part.bodyStart, part.end), part.encoding)
    try {
      out.push(unpack(bytes).toString("utf8"))
    } catch (e) {
      console.warn(`[corsair] unreadable report attachment: ${(e as Error).message}`)
    }
  })
  return out
}

export type IngestOutcome = {
  stored: number
  refused: string[]
}

const storedToday = async (domainId: string): Promise<number> => {
  const midnight = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`)
  const row = await db().one<{ count: string }>({
    text: `SELECT ((SELECT count(*) FROM dmarc_reports WHERE domain_id = $1 AND created_at >= $2)
                 + (SELECT count(*) FROM tls_reports WHERE domain_id = $1 AND created_at >= $2))::text AS count`,
    values: [domainId, midnight],
  })
  return Number(row?.count ?? 0)
}

/** True when stored, false when this exact report was already on file. */
export const storeDmarcReport = async (
  domain: Domain,
  report: AggregateReport,
): Promise<boolean> => {
  if (!coversDomain(report.policy.domain, domain.name))
    throw new Error(`Report is about ${report.policy.domain}, not ${domain.name}.`)

  const total = report.records.reduce((sum, r) => sum + r.count, 0)
  const passed = report.records.filter(recordPassed).reduce((sum, r) => sum + r.count, 0)

  return db().transaction(async (conn) => {
    const row = await conn.one<{ id: string }>({
      text: `INSERT INTO dmarc_reports (domain_id, org_name, org_email, report_id, policy_domain,
                                        policy_p, policy_sp, policy_pct, adkim, aspf,
                                        date_begin, date_end, message_count, pass_count, fail_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (domain_id, org_name, report_id) DO NOTHING
             RETURNING id`,
      values: [
        domain.id,
        report.orgName,
        report.email,
        report.reportId,
        report.policy.domain,
        report.policy.p,
        report.policy.sp,
        report.policy.pct,
        report.policy.adkim,
        report.policy.aspf,
        report.begin,
        report.end,
        Math.min(total, 2_000_000_000),
        Math.min(passed, 2_000_000_000),
        Math.min(total - passed, 2_000_000_000),
      ],
    })
    if (!row) return false
    if (!report.records.length) return true

    // One statement for every record. The array goes in as-is and is expanded
    // server-side; see the note on Bun's driver in CLAUDE.md.
    await conn.execute({
      text: `INSERT INTO dmarc_report_records (report_id, source_ip, count, disposition, dkim_eval,
                                               spf_eval, header_from, envelope_from,
                                               dkim_results, spf_results)
             SELECT $1, x.source_ip, x.count, x.disposition, x.dkim_eval, x.spf_eval,
                    x.header_from, x.envelope_from, x.dkim_results, x.spf_results
               FROM jsonb_to_recordset($2::jsonb) AS x(source_ip text, count int, disposition text,
                    dkim_eval text, spf_eval text, header_from text, envelope_from text,
                    dkim_results jsonb, spf_results jsonb)`,
      values: [
        row.id,
        report.records.map((r) => ({
          source_ip: r.sourceIp,
          count: r.count,
          disposition: r.disposition,
          dkim_eval: r.dkimEval,
          spf_eval: r.spfEval,
          header_from: r.headerFrom,
          envelope_from: r.envelopeFrom,
          dkim_results: r.dkim,
          spf_results: r.spf,
        })),
      ],
    })
    return true
  })
}

export const storeTlsReport = async (domain: Domain, report: TlsReportDoc): Promise<boolean> => {
  // Entries about other domains are dropped one by one; a report left with none
  // is refused whole.
  const policies = report.policies.filter((p) => coversDomain(p.policyDomain, domain.name))
  if (!policies.length) throw new Error(`Report has no policy for ${domain.name}.`)

  const success = policies.reduce((sum, p) => sum + p.success, 0)
  const failure = policies.reduce((sum, p) => sum + p.failure, 0)

  return db().transaction(async (conn) => {
    const row = await conn.one<{ id: string }>({
      text: `INSERT INTO tls_reports (domain_id, org_name, report_id, contact, date_begin, date_end,
                                      success_count, failure_count)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (domain_id, org_name, report_id) DO NOTHING
             RETURNING id`,
      values: [
        domain.id,
        report.orgName,
        report.reportId,
        report.contact,
        report.begin,
        report.end,
        Math.min(success, 2_000_000_000),
        Math.min(failure, 2_000_000_000),
      ],
    })
    if (!row) return false
    await conn.execute({
      text: `INSERT INTO tls_report_policies (report_id, policy_type, policy_domain, mx_host,
                                              success_count, failure_count, failures)
             SELECT $1, x.policy_type, x.policy_domain, x.mx_host, x.success_count,
                    x.failure_count, x.failures
               FROM jsonb_to_recordset($2::jsonb) AS x(policy_type text, policy_domain text,
                    mx_host text, success_count int, failure_count int, failures jsonb)`,
      values: [
        row.id,
        policies.map((p) => ({
          policy_type: p.policyType,
          policy_domain: p.policyDomain,
          mx_host: p.mxHost,
          success_count: p.success,
          failure_count: p.failure,
          failures: p.failures,
        })),
      ],
    })
    return true
  })
}

/**
 * Reads every report in a message and files it under the domain.
 *
 * Only for mail whose sender authenticated (SPF or DKIM passed — the same test
 * as `mayBounceTo`). Every large reporter signs its reports, and without the
 * check anyone could invent traffic in a customer's dashboard by mailing an
 * XML file. Never throws: a malformed report must not fail the delivery of the
 * message it arrived in.
 */
export const ingestReports = async (
  domain: Domain,
  raw: string,
  parsed: mime.ParsedMessage,
  authenticated: boolean,
): Promise<IngestOutcome> => {
  const outcome: IngestOutcome = { stored: 0, refused: [] }
  if (!authenticated) {
    outcome.refused.push("sender did not authenticate")
    return outcome
  }
  try {
    const payloads = reportPayloads(raw, parsed)
    if (!payloads.length) return outcome
    if ((await storedToday(domain.id)) >= DAILY_REPORT_CAP) {
      outcome.refused.push("daily report limit reached")
      return outcome
    }
    for (const payload of payloads) {
      try {
        const trimmed = payload.trimStart()
        const stored = trimmed.startsWith("{")
          ? await storeTlsReport(domain, parseTlsReport(trimmed))
          : await storeDmarcReport(domain, parseAggregate(trimmed))
        if (stored) outcome.stored++
      } catch (e) {
        outcome.refused.push((e as Error).message)
      }
    }
  } catch (e) {
    outcome.refused.push((e as Error).message)
  }
  return outcome
}

// summaries

/** Postgres `count` and `sum` come back as bigint or numeric text. */
type Big = bigint | string | number | null

export type DmarcSourceRow = {
  source_ip: string
  messages: Big
  passed: Big
  failed: Big
  reporters: string | null
}
export type DmarcOrgRow = {
  org_name: string
  reports: Big
  messages: Big
  passed: Big
  failed: Big
}
export type TlsOrgRow = { org_name: string; reports: Big; succeeded: Big; failed: Big }
export type TlsResultRow = { result_type: string; sessions: Big }
export type DmarcTotals = { reports: Big; messages: Big; passed: Big; failed: Big }
export type TlsTotals = { reports: Big; succeeded: Big; failed: Big }

const since = (days: number) => new Date(Date.now() - days * 86_400_000)

export const dmarcSummary = async (domainId: string, days: number) => {
  const after = since(days)
  const [totals, reports, bySource, byOrg] = await Promise.all([
    db().one<DmarcTotals>({
      text: `SELECT count(*) AS reports, coalesce(sum(message_count), 0) AS messages,
                    coalesce(sum(pass_count), 0) AS passed, coalesce(sum(fail_count), 0) AS failed
               FROM dmarc_reports WHERE domain_id = $1 AND date_end >= $2`,
      values: [domainId, after],
    }),
    db().all<DmarcReport>({
      text: `SELECT * FROM dmarc_reports WHERE domain_id = $1 AND date_end >= $2
              ORDER BY date_end DESC LIMIT 100`,
      values: [domainId, after],
    }),
    db().all<DmarcSourceRow>({
      text: `SELECT r.source_ip,
                    sum(r.count) AS messages,
                    sum(CASE WHEN r.dkim_eval = 'pass' OR r.spf_eval = 'pass' THEN r.count ELSE 0 END) AS passed,
                    sum(CASE WHEN r.dkim_eval = 'pass' OR r.spf_eval = 'pass' THEN 0 ELSE r.count END) AS failed,
                    array_to_string((array_agg(DISTINCT d.org_name))[1:5], ', ') AS reporters
               FROM dmarc_report_records r JOIN dmarc_reports d ON d.id = r.report_id
              WHERE d.domain_id = $1 AND d.date_end >= $2
              GROUP BY r.source_ip ORDER BY messages DESC LIMIT 100`,
      values: [domainId, after],
    }),
    db().all<DmarcOrgRow>({
      text: `SELECT org_name, count(*) AS reports, sum(message_count) AS messages,
                    sum(pass_count) AS passed, sum(fail_count) AS failed
               FROM dmarc_reports WHERE domain_id = $1 AND date_end >= $2
              GROUP BY org_name ORDER BY messages DESC LIMIT 50`,
      values: [domainId, after],
    }),
  ])
  return { totals, reports, bySource, byOrg }
}

export const tlsSummary = async (domainId: string, days: number) => {
  const after = since(days)
  const [totals, reports, byOrg, byResult] = await Promise.all([
    db().one<TlsTotals>({
      text: `SELECT count(*) AS reports, coalesce(sum(success_count), 0) AS succeeded,
                    coalesce(sum(failure_count), 0) AS failed
               FROM tls_reports WHERE domain_id = $1 AND date_end >= $2`,
      values: [domainId, after],
    }),
    db().all<TlsReport>({
      text: `SELECT * FROM tls_reports WHERE domain_id = $1 AND date_end >= $2
              ORDER BY date_end DESC LIMIT 100`,
      values: [domainId, after],
    }),
    db().all<TlsOrgRow>({
      text: `SELECT org_name, count(*) AS reports, sum(success_count) AS succeeded,
                    sum(failure_count) AS failed
               FROM tls_reports WHERE domain_id = $1 AND date_end >= $2
              GROUP BY org_name ORDER BY sum(success_count) + sum(failure_count) DESC LIMIT 50`,
      values: [domainId, after],
    }),
    db().all<TlsResultRow>({
      text: `SELECT f->>'result_type' AS result_type,
                    sum(coalesce((f->>'failed_session_count')::bigint, 0)) AS sessions
               FROM tls_report_policies p JOIN tls_reports t ON t.id = p.report_id
                    CROSS JOIN LATERAL jsonb_array_elements(p.failures) AS f
              WHERE t.domain_id = $1 AND t.date_end >= $2
              GROUP BY 1 ORDER BY sessions DESC LIMIT 20`,
      values: [domainId, after],
    }),
  ])
  return { totals, reports, byOrg, byResult }
}
