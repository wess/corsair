import { resolveTxt } from "node:dns/promises"
import { gzipSync } from "node:zlib"
import { from } from "@wess/atlas/db/query"
import { config } from "../../config/index.ts"
import type { TlsRptResultType } from "../../dane/index.ts"
import { db } from "../../db/index.ts"
import { sign } from "../../dkim/index.ts"
import { buildAggregate, MAX_RECORDS, type OutboundRow } from "../../dmarc/index.ts"
import { activeDkimKey } from "../../domains/index.ts"
import { rfcMessageId } from "../../ids/index.ts"
import * as mime from "../../mime/index.ts"
import { enqueue } from "../../outbound/index.ts"
import { safeFetch } from "../../safefetch/index.ts"
import { type Domain, domains } from "../../schema/index.ts"
import { type DmarcPolicy, lookupDmarc, type TxtResolver } from "../../spf/index.ts"
import { buildTlsReport, type OutboundTlsRow } from "../../tlsrpt/index.ts"

/**
 * The reports this server sends: one DMARC aggregate report per day to every
 * domain that mailed us and publishes `rua`, and one TLS report per day to every
 * domain we mailed that publishes `_smtp._tls`.
 *
 * Outcomes are recorded as they happen into day-bucketed counter rows, and a
 * periodic job (`reports.send` in `src/worker`) turns each finished UTC day into
 * a report and deletes the rows behind it. A claim row in `report_sends` is
 * taken before anything is built, so two workers never send the same report and
 * a crash mid-send loses that one report rather than repeating it.
 */

const RETENTION_DAYS = 7
const MAX_DESTINATIONS = 5

export const utcDay = (d: Date = new Date()): string => d.toISOString().slice(0, 10)

export const reporterAddress = (): string =>
  config.reports.from || `noreply-dmarc@${config.hostname}`

// record

export type DmarcObservation = {
  policy: Pick<DmarcPolicy, "domain" | "rua">
  headerFrom: string
  sourceIp: string
  envelopeFrom: string
  spf: { result: string; domain: string; aligned: boolean }
  dkim: { result: string; domain: string | null; aligned: boolean }
  disposition: "none" | "quarantine" | "reject"
}

/**
 * Counts one evaluated message toward today's report. Only for a policy that
 * asks for reports — a domain with no `rua` gets nothing, so there is nothing to
 * keep. Never throws; this is called from the delivery path.
 */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i

export const recordDmarc = async (o: DmarcObservation, now = new Date()): Promise<void> => {
  if (!config.reports.dmarcSend || !o.policy.rua.length) return
  // Both names end up in a subject line and a filename; anything that is not a
  // plain hostname is not worth reporting on.
  if (!HOSTNAME.test(o.policy.domain) || !HOSTNAME.test(o.headerFrom)) return
  await db()
    .execute({
      text: `INSERT INTO dmarc_evaluations (day, policy_domain, header_from, source_ip, envelope_from,
                                            spf_result, spf_domain, spf_aligned, dkim_result,
                                            dkim_domain, dkim_aligned, disposition)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (day, policy_domain, header_from, source_ip, envelope_from, spf_result,
                          spf_domain, spf_aligned, dkim_result, dkim_domain, dkim_aligned,
                          disposition)
             DO UPDATE SET count = dmarc_evaluations.count + 1`,
      values: [
        utcDay(now),
        o.policy.domain.toLowerCase(),
        o.headerFrom.toLowerCase().slice(0, 253),
        o.sourceIp.slice(0, 64),
        envelopeDomain(o.envelopeFrom),
        o.spf.result,
        o.spf.domain.toLowerCase().slice(0, 253),
        o.spf.aligned,
        o.dkim.result,
        (o.dkim.domain ?? "").toLowerCase().slice(0, 253),
        o.dkim.aligned,
        o.disposition,
      ],
    })
    .catch((e: unknown) => console.error("[corsair] could not record a DMARC result:", e))
}

// The report carries the envelope sender's domain, not the address.
const envelopeDomain = (address: string): string => {
  const at = address.lastIndexOf("@")
  return at === -1
    ? ""
    : address
        .slice(at + 1)
        .toLowerCase()
        .slice(0, 253)
}

export type TlsSessionResult = {
  host: string
  /** `tlsa` when a DANE policy applied to the session (src/dane). */
  policy: "tlsa" | "no-policy-found"
  result: "success" | TlsRptResultType
  detail: string
}

export const recordTls = async (
  policyDomain: string,
  sessions: TlsSessionResult[],
  now = new Date(),
): Promise<void> => {
  if (!config.reports.tlsSend || !HOSTNAME.test(policyDomain)) return
  for (const s of sessions) {
    await db()
      .execute({
        text: `INSERT INTO tls_outcomes (day, policy_domain, mx_host, result, detail, policy_type)
               VALUES ($1, $2, $3, $4, $5, $6)
               ON CONFLICT (day, policy_domain, mx_host, result, policy_type)
               DO UPDATE SET count = tls_outcomes.count + 1, detail = EXCLUDED.detail`,
        values: [
          utcDay(now),
          policyDomain.toLowerCase().slice(0, 253),
          s.host.toLowerCase().slice(0, 253),
          s.result,
          mime.stripControls(s.detail).slice(0, 200),
          s.policy,
        ],
      })
      .catch((e: unknown) => console.error("[corsair] could not record a TLS result:", e))
  }
}

// destinations

/**
 * The mailto addresses in a `rua` list. A size limit suffix (`!10m`) is
 * dropped, percent-escapes are decoded, and anything that is not a plain
 * address — or would not survive `enqueue`'s check — is skipped.
 */
export const mailtoDestinations = (rua: string[]): string[] => {
  const out: string[] = []
  for (const uri of rua) {
    const m = uri.trim().match(/^mailto:([^!?]+)/i)
    if (!m) continue
    let address: string
    try {
      address = decodeURIComponent(m[1]!).trim().toLowerCase()
    } catch {
      continue
    }
    if (!/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(address) || !mime.isSafeAddress(address)) continue
    if (!out.includes(address)) out.push(address)
  }
  return out.slice(0, MAX_DESTINATIONS)
}

/**
 * RFC 7489 §7.1: before reporting about `policyDomain` to an address at some
 * other domain, that domain has to have agreed, by publishing
 * `<policyDomain>._report._dmarc.<destination>` with a `v=DMARC1` TXT record.
 * Without the check, anyone could publish a record naming a stranger's address
 * and have this server mail them a report every day.
 *
 * "The same domain" is deliberately narrow: the destination is the policy
 * domain or under it. The RFC allows any domain in the same organisational
 * domain, but deciding that needs the public suffix list, and guessing it
 * (last two labels) would call `a.co.uk` and `b.co.uk` one organisation.
 */
export const destinationAllowed = async (
  policyDomain: string,
  destination: string,
  resolve: TxtResolver = resolveTxt,
): Promise<boolean> => {
  const at = destination.lastIndexOf("@")
  const destDomain = destination.slice(at + 1).toLowerCase()
  const policy = policyDomain.toLowerCase()
  if (destDomain === policy || destDomain.endsWith(`.${policy}`)) return true
  try {
    const records = await resolve(`${policy}._report._dmarc.${destDomain}`)
    return records.some((chunks) => /^v=DMARC1(\s*;|\s*$)/i.test(chunks.join("").trim()))
  } catch {
    return false
  }
}

/** The `rua` list from a domain's `_smtp._tls` record, or null if it has none. */
export const lookupTlsRpt = async (
  domain: string,
  resolve: TxtResolver = resolveTxt,
): Promise<string[] | null> => {
  try {
    const records = (await resolve(`_smtp._tls.${domain}`)).map((c) => c.join("").trim())
    const record = records.find((r) => /^v=TLSRPTv1\s*(;|$)/i.test(r))
    if (!record) return null
    const rua = record
      .split(";")
      .map((part) => part.trim())
      .find((part) => /^rua\s*=/i.test(part))
    if (!rua) return null
    return rua
      .slice(rua.indexOf("=") + 1)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return null
  }
}

// message

const reportMessage = (input: {
  to: string[]
  subject: string
  headers?: Record<string, string>
  contentType: string
  text: string
  attachment: { filename: string; contentType: string; content: Buffer }
}): string => {
  const sep = `=_corsair_report_${Math.random().toString(36).slice(2)}`
  const header = (name: string, value: string) => `${name}: ${mime.stripControls(value)}`
  const filename = mime.stripControls(input.attachment.filename)
  return [
    header("Date", new Date().toUTCString()),
    header("From", `<${reporterAddress()}>`),
    header("To", input.to.map((a) => `<${a}>`).join(", ")),
    header("Subject", input.subject),
    header("Message-ID", rfcMessageId(config.hostname)),
    ...Object.entries(input.headers ?? {}).map(([k, v]) => header(k, v)),
    "Auto-Submitted: auto-generated",
    "MIME-Version: 1.0",
    `Content-Type: ${input.contentType}; boundary="${sep}"`,
    "",
    `--${sep}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    input.text,
    "",
    `--${sep}`,
    `Content-Type: ${input.attachment.contentType}; name="${filename}"`,
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    mime.encodeBase64Lines(input.attachment.content),
    `--${sep}--`,
    "",
  ].join("\r\n")
}

/**
 * Signed when the reporter address is on a domain hosted here with an active
 * key. RFC 8460 requires a signed TLS report and receivers discard unsigned
 * ones; for DMARC it is not required but it is what keeps a report out of spam.
 */
const signed = async (raw: string): Promise<string> => {
  const reporterDomain = reporterAddress().split("@")[1]?.toLowerCase() ?? ""
  const domain = await db().one<Domain>(
    from(domains).where((q) => q("name").equals(reporterDomain)),
  )
  const key = domain ? await activeDkimKey(domain.id) : null
  return key && domain
    ? sign({ raw, domain: domain.name, selector: key.selector, privateKey: key.private_key })
    : raw
}

// run

type Kind = "dmarc" | "tlsrpt"

const sentToday = async (kind: Kind, now: Date): Promise<number> => {
  const row = await db().one<{ count: string }>({
    text: `SELECT count(*)::text AS count FROM report_sends
            WHERE kind = $1 AND status = 'sent' AND created_at >= $2`,
    values: [kind, new Date(`${utcDay(now)}T00:00:00Z`)],
  })
  return Number(row?.count ?? 0)
}

const claim = async (kind: Kind, domain: string, day: string): Promise<string | null> => {
  const row = await db().one<{ id: string }>({
    text: `INSERT INTO report_sends (kind, policy_domain, day) VALUES ($1, $2, $3)
           ON CONFLICT (kind, policy_domain, day) DO NOTHING RETURNING id`,
    values: [kind, domain, day],
  })
  return row?.id ?? null
}

const settle = async (id: string, status: string, detail: string | null): Promise<void> => {
  await db().execute({
    text: "UPDATE report_sends SET status = $2, detail = $3 WHERE id = $1",
    values: [id, status, detail?.slice(0, 500) ?? null],
  })
}

const dayBounds = (day: string): { begin: Date; end: Date } => {
  const begin = new Date(`${day}T00:00:00Z`)
  return { begin, end: new Date(begin.getTime() + 86_400_000 - 1000) }
}

export type RunOptions = {
  now?: Date
  resolve?: TxtResolver
  /** For an `https:` TLS report destination. Defaults to `safeFetch`. */
  post?: (url: string, body: Buffer) => Promise<{ ok: boolean; status: number }>
}

const sendDmarc = async (
  day: string,
  policyDomain: string,
  resolve: TxtResolver,
): Promise<{ status: string; detail: string | null }> => {
  const policy = await lookupDmarc(policyDomain, resolve)
  // Only the domain's own record counts. One that resolved to its parent's is
  // somebody else's rua.
  if (!policy || policy.domain !== policyDomain || !policy.rua.length)
    return { status: "skipped", detail: "no rua published" }

  const destinations: string[] = []
  for (const address of mailtoDestinations(policy.rua)) {
    if (await destinationAllowed(policyDomain, address, resolve)) destinations.push(address)
  }
  if (!destinations.length)
    return { status: "skipped", detail: "no rua destination is verified for this domain" }

  const rows = await db().all<OutboundRow>({
    text: `SELECT source_ip, count, disposition, header_from, envelope_from, spf_result,
                  spf_domain, spf_aligned, dkim_result, dkim_domain, dkim_aligned
             FROM dmarc_evaluations WHERE day = $1 AND policy_domain = $2
            ORDER BY count DESC LIMIT $3`,
    values: [day, policyDomain, MAX_RECORDS],
  })
  if (!rows.length) return { status: "skipped", detail: "nothing to report" }

  const { begin, end } = dayBounds(day)
  const reportId = `${day}.${policyDomain}.${crypto.randomUUID().slice(0, 8)}`
  const xml = buildAggregate({
    orgName: config.hostname,
    email: reporterAddress(),
    reportId,
    begin,
    end,
    policy: {
      domain: policyDomain,
      p: policy.policy,
      sp: policy.subdomainPolicy,
      pct: Number.isFinite(policy.percent) ? policy.percent : 100,
      adkim: policy.adkim === "strict" ? "s" : "r",
      aspf: policy.aspf === "strict" ? "s" : "r",
    },
    rows,
  })
  const stamp = (d: Date) => Math.floor(d.getTime() / 1000)
  const raw = reportMessage({
    to: destinations,
    subject: `Report Domain: ${policyDomain} Submitter: ${config.hostname} Report-ID: <${reportId}>`,
    contentType: "multipart/mixed",
    text: `DMARC aggregate report for ${policyDomain} from ${config.hostname}, covering ${day} (UTC).`,
    attachment: {
      filename: `${config.hostname}!${policyDomain}!${stamp(begin)}!${stamp(end)}.xml.gz`,
      contentType: "application/gzip",
      content: gzipSync(Buffer.from(xml, "utf8")),
    },
  })
  await enqueue({ raw: await signed(raw), mailFrom: reporterAddress(), recipients: destinations })
  return { status: "sent", detail: destinations.join(", ") }
}

const sendTls = async (
  day: string,
  policyDomain: string,
  opts: Required<Pick<RunOptions, "resolve" | "post">>,
): Promise<{ status: string; detail: string | null }> => {
  const rua = await lookupTlsRpt(policyDomain, opts.resolve)
  if (!rua?.length) return { status: "skipped", detail: "no TLS-RPT record published" }

  const rows = await db().all<OutboundTlsRow>({
    text: `SELECT policy_type, mx_host, result, detail, count FROM tls_outcomes
            WHERE day = $1 AND policy_domain = $2 ORDER BY count DESC LIMIT 500`,
    values: [day, policyDomain],
  })
  if (!rows.length) return { status: "skipped", detail: "nothing to report" }

  const { begin, end } = dayBounds(day)
  const reportId = `${day}.${policyDomain}.${crypto.randomUUID().slice(0, 8)}@${config.hostname}`
  const json = buildTlsReport({
    orgName: config.hostname,
    contact: `mailto:${reporterAddress()}`,
    reportId,
    begin,
    end,
    policyDomain,
    rows,
  })
  const gz = gzipSync(Buffer.from(json, "utf8"))
  const sentTo: string[] = []

  // RFC 8460 puts no third-party authorisation on TLS report destinations: the
  // record is the recipient domain's own statement of where its reports go.
  const mailto = mailtoDestinations(rua)
  if (mailto.length) {
    const stamp = (d: Date) => Math.floor(d.getTime() / 1000)
    const raw = reportMessage({
      to: mailto,
      subject: `Report Domain: ${policyDomain} Submitter: ${config.hostname} Report-ID: <${reportId}>`,
      headers: {
        "TLS-Report-Domain": policyDomain,
        "TLS-Report-Submitter": config.hostname,
      },
      contentType: 'multipart/report; report-type="tlsrpt"',
      text: `SMTP TLS report for ${policyDomain} from ${config.hostname}, covering ${day} (UTC).`,
      attachment: {
        filename: `${config.hostname}!${policyDomain}!${stamp(begin)}!${stamp(end)}.json.gz`,
        contentType: "application/tlsrpt+gzip",
        content: gz,
      },
    })
    await enqueue({ raw: await signed(raw), mailFrom: reporterAddress(), recipients: mailto })
    sentTo.push(...mailto)
  }

  for (const uri of rua.filter((u) => /^https:\/\//i.test(u)).slice(0, MAX_DESTINATIONS)) {
    // The URL is the recipient domain's to choose, which makes it as untrusted as
    // a webhook endpoint: `safeFetch` resolves and judges the address first.
    const result = await opts.post(uri, gz).catch(() => ({ ok: false, status: 0 }))
    if (result.ok) sentTo.push(uri)
  }

  return sentTo.length
    ? { status: "sent", detail: sentTo.join(", ") }
    : { status: "failed", detail: "no destination accepted the report" }
}

const postReport = async (url: string, body: Buffer): Promise<{ ok: boolean; status: number }> => {
  const res = await safeFetch(url, {
    method: "POST",
    headers: { "content-type": "application/tlsrpt+gzip" },
    body: new Uint8Array(body),
    signal: AbortSignal.timeout(30_000),
  })
  await res.body?.cancel().catch(() => {})
  return { ok: res.ok, status: res.status }
}

export type RunResult = { dmarc: number; tlsrpt: number; skipped: number; capped: boolean }

/**
 * Sends every report for a finished day that has not been sent, up to the
 * daily cap, then drops what is older than the retention window — rows left
 * behind by the cap, or by a domain whose report could not be built.
 */
export const runReports = async (options: RunOptions = {}): Promise<RunResult> => {
  const now = options.now ?? new Date()
  const resolve = options.resolve ?? resolveTxt
  const post = options.post ?? postReport
  const today = utcDay(now)
  const result: RunResult = { dmarc: 0, tlsrpt: 0, skipped: 0, capped: false }

  const kinds: { kind: Kind; table: string; enabled: boolean }[] = [
    { kind: "dmarc", table: "dmarc_evaluations", enabled: config.reports.dmarcSend },
    { kind: "tlsrpt", table: "tls_outcomes", enabled: config.reports.tlsSend },
  ]

  for (const { kind, table, enabled } of kinds) {
    if (!enabled) continue
    const pending = await db().all<{ day: string; policy_domain: string }>({
      text: `SELECT DISTINCT day, policy_domain FROM ${table} WHERE day < $1
              ORDER BY day, policy_domain LIMIT 5000`,
      values: [today],
    })
    let sent = await sentToday(kind, now)
    for (const { day, policy_domain } of pending) {
      if (sent >= config.reports.dailyCap) {
        result.capped = true
        break
      }
      const id = await claim(kind, policy_domain, day)
      if (id) {
        const outcome = await (kind === "dmarc"
          ? sendDmarc(day, policy_domain, resolve)
          : sendTls(day, policy_domain, { resolve, post })
        ).catch((e: unknown) => ({ status: "failed", detail: (e as Error).message }))
        await settle(id, outcome.status, outcome.detail)
        if (outcome.status === "sent") {
          sent++
          result[kind]++
        } else result.skipped++
      }
      await db().execute({
        text: `DELETE FROM ${table} WHERE day = $1 AND policy_domain = $2`,
        values: [day, policy_domain],
      })
    }
  }

  const cutoff = utcDay(new Date(now.getTime() - RETENTION_DAYS * 86_400_000))
  await db().execute({ text: "DELETE FROM dmarc_evaluations WHERE day < $1", values: [cutoff] })
  await db().execute({ text: "DELETE FROM tls_outcomes WHERE day < $1", values: [cutoff] })
  await db().execute({
    text: "DELETE FROM report_sends WHERE created_at < now() - interval '30 days'",
    values: [],
  })
  return result
}
