import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { deflateRawSync, gunzipSync, gzipSync } from "node:zlib"
import { createAddress } from "../src/addresses/index.ts"
import { buildFetch } from "../src/api/index.ts"
import { gunzipBounded, MAX_REPORT_BYTES, unpack, unzipBounded } from "../src/archive/index.ts"
import { issueSession, SESSION_COOKIE } from "../src/auth/index.ts"
import {
  coversDomain,
  dmarcSummary,
  ingestReports,
  storeDmarcReport,
  tlsSummary,
} from "../src/authreports/index.ts"
import {
  destinationAllowed,
  lookupTlsRpt,
  mailtoDestinations,
  recordDmarc,
  recordTls,
  runReports,
  utcDay,
} from "../src/authreports/outbound/index.ts"
import { config } from "../src/config/index.ts"
import { db } from "../src/db/index.ts"
import { buildAggregate, parseAggregate } from "../src/dmarc/index.ts"
import * as mime from "../src/mime/index.ts"
import { inlineBody } from "../src/outbound/index.ts"
import type { Delivery, Domain } from "../src/schema/index.ts"
import { handleMessage, validateRecipient } from "../src/smtp/inbound/index.ts"
import type { Envelope } from "../src/smtp/session/index.ts"
import { buildTlsReport, parseTlsReport } from "../src/tlsrpt/index.ts"
import { parseXml } from "../src/xml/index.ts"

/**
 * DMARC aggregate and TLS reports, received and sent.
 *
 * The cases that carry weight are the refusals: a report about somebody else's
 * domain must not land in this one's tables, a zip that expands to gigabytes
 * must stop at the cap, and a `rua` naming a stranger's address must not be
 * mailed until that stranger's DNS has agreed to it.
 *
 * Needs Postgres. DNS is stubbed wherever a result matters.
 */

// fixtures

/** Yesterday, UTC midnight, as reports date themselves. */
const BEGIN = Math.floor(Date.now() / 86_400_000) * 86_400 - 86_400

/** Shaped like the reports Google sends, namespace and all. */
const googleXml = (
  domain: string,
  reportId = "17282828282828282828",
) => `<?xml version="1.0" encoding="UTF-8" ?>
<feedback xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <version>1.0</version>
  <report_metadata>
    <org_name>google.com</org_name>
    <email>noreply-dmarc-support@google.com</email>
    <extra_contact_info>https://support.google.com/a/answer/2466580</extra_contact_info>
    <report_id>${reportId}</report_id>
    <date_range>
      <begin>${BEGIN}</begin>
      <end>${BEGIN + 86399}</end>
    </date_range>
  </report_metadata>
  <policy_published>
    <domain>${domain}</domain>
    <adkim>r</adkim>
    <aspf>r</aspf>
    <p>quarantine</p>
    <sp>quarantine</sp>
    <pct>100</pct>
    <np>quarantine</np>
  </policy_published>
  <record>
    <row>
      <source_ip>203.0.113.25</source_ip>
      <count>12</count>
      <policy_evaluated>
        <disposition>none</disposition>
        <dkim>pass</dkim>
        <spf>pass</spf>
      </policy_evaluated>
    </row>
    <identifiers>
      <header_from>${domain}</header_from>
    </identifiers>
    <auth_results>
      <dkim>
        <domain>${domain}</domain>
        <result>pass</result>
        <selector>corsair-1</selector>
      </dkim>
      <spf>
        <domain>${domain}</domain>
        <result>pass</result>
      </spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>2001:db8::7</source_ip>
      <count>3</count>
      <policy_evaluated>
        <disposition>quarantine</disposition>
        <dkim>fail</dkim>
        <spf>fail</spf>
        <reason><type>local_policy</type><comment>arc=fail</comment></reason>
      </policy_evaluated>
    </row>
    <identifiers>
      <envelope_from>spoof.example</envelope_from>
      <header_from>${domain}</header_from>
    </identifiers>
    <auth_results>
      <spf>
        <domain>spoof.example</domain>
        <result>softfail</result>
      </spf>
    </auth_results>
  </record>
  <record>
    <row>
      <source_ip>not-an-ip</source_ip>
      <count>99</count>
      <policy_evaluated><disposition>none</disposition><dkim>pass</dkim><spf>pass</spf></policy_evaluated>
    </row>
    <identifiers><header_from>${domain}</header_from></identifiers>
    <auth_results><spf><domain>${domain}</domain><result>pass</result></spf></auth_results>
  </record>
</feedback>
`

/** Shaped like Microsoft's TLS reports. */
const microsoftJson = (domain: string, reportId = "133752000000000000+example") =>
  JSON.stringify({
    "organization-name": "Microsoft Corporation",
    "date-range": {
      "start-datetime": new Date(BEGIN * 1000).toISOString(),
      "end-datetime": new Date((BEGIN + 86399) * 1000).toISOString(),
    },
    "contact-info": "tlsrpt-noreply@microsoft.com",
    "report-id": reportId,
    policies: [
      {
        policy: {
          "policy-type": "sts",
          "policy-string": [
            "version: STSv1",
            "mode: enforce",
            `mx: mx1.${domain}`,
            "max_age: 86400",
          ],
          "policy-domain": domain,
          "mx-host": [`mx1.${domain}`],
        },
        summary: { "total-successful-session-count": 41, "total-failure-session-count": 2 },
        "failure-details": [
          {
            "result-type": "certificate-expired",
            "sending-mta-ip": "40.107.1.1",
            "receiving-mx-hostname": `mx1.${domain}`,
            "receiving-ip": "203.0.113.25",
            "failed-session-count": 2,
          },
        ],
      },
      {
        policy: { "policy-type": "no-policy-found", "policy-domain": "someone-else.example" },
        summary: { "total-successful-session-count": 1000, "total-failure-session-count": 0 },
      },
    ],
  })

// A zip writer, small and literal, so the reader is tested against the real
// format rather than against itself.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf: Buffer): number => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const zip = (name: string, data: Buffer, opts: { store?: boolean; declaredSize?: number } = {}) => {
  const method = opts.store ? 0 : 8
  const body = opts.store ? data : deflateRawSync(data)
  const nameBuf = Buffer.from(name, "latin1")
  const size = opts.declaredSize ?? data.length
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(method, 8)
  local.writeUInt32LE(crc32(data), 14)
  local.writeUInt32LE(body.length, 18)
  local.writeUInt32LE(size, 22)
  local.writeUInt16LE(nameBuf.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt16LE(method, 10)
  central.writeUInt32LE(crc32(data), 16)
  central.writeUInt32LE(body.length, 20)
  central.writeUInt32LE(size, 24)
  central.writeUInt16LE(nameBuf.length, 28)
  central.writeUInt32LE(0, 42)
  const dirOffset = local.length + nameBuf.length + body.length
  const dirSize = central.length + nameBuf.length
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10)
  end.writeUInt32LE(dirSize, 12)
  end.writeUInt32LE(dirOffset, 16)
  return Buffer.concat([local, nameBuf, body, central, nameBuf, end])
}

const reportMail = (to: string, attachment: { type: string; name: string; content: Buffer }) =>
  [
    "From: noreply-dmarc-support@google.com",
    `To: ${to}`,
    "Subject: Report domain: example Submitter: google.com",
    "Message-ID: <report-1@google.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="r1"',
    "",
    "--r1",
    "Content-Type: text/plain",
    "",
    "This is an aggregate report.",
    "",
    "--r1",
    `Content-Type: ${attachment.type}; name="${attachment.name}"`,
    `Content-Disposition: attachment; filename="${attachment.name}"`,
    "Content-Transfer-Encoding: base64",
    "",
    mime.encodeBase64Lines(attachment.content),
    "--r1--",
    "",
  ].join("\r\n")

const parsedOf = (raw: string) => {
  const normalized = mime.normalizeEol(raw)
  return { normalized, parsed: mime.parseMessage(normalized) }
}

// archives

describe("archives", () => {
  test("gzip, zip (deflated and stored), and plain all unpack to the same text", () => {
    const xml = Buffer.from(googleXml("example.com"))
    expect(unpack(gzipSync(xml)).toString()).toBe(xml.toString())
    expect(unpack(zip("google.com!example.com!1!2.xml", xml)).toString()).toBe(xml.toString())
    expect(unpack(zip("report.xml", xml, { store: true })).toString()).toBe(xml.toString())
    expect(unpack(xml).toString()).toBe(xml.toString())
    expect(unzipBounded(zip("a.xml", xml))[0]!.name).toBe("a.xml")
  })

  test("a gzip bomb stops at the cap instead of expanding", () => {
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024))
    expect(bomb.length).toBeLessThan(200_000)
    expect(() => gunzipBounded(bomb)).toThrow(/larger than the limit/)
    expect(() => unpack(bomb, 1024 * 1024)).toThrow(/larger than the limit/)
  })

  test("a zip bomb is refused whether or not it declares its real size", () => {
    const zeros = Buffer.alloc(MAX_REPORT_BYTES + 1024 * 1024)
    // Honest about its size: refused before anything is inflated.
    expect(() => unpack(zip("bomb.xml", zeros))).toThrow(/larger than the limit/)
    // Lies about it: the inflate itself is capped.
    expect(() => unpack(zip("bomb.xml", zeros, { declaredSize: 100 }))).toThrow(
      /larger than the limit/,
    )
  })

  test("garbage that looks like a zip is an error, not a crash", () => {
    const fake = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40, 7)])
    expect(() => unpack(fake)).toThrow()
  })
})

// parsing

describe("parsing", () => {
  test("a DOCTYPE is refused, so no entity can be declared", () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE feedback [<!ENTITY x SYSTEM "file:///etc/passwd">]><feedback>&x;</feedback>`
    expect(() => parseXml(xxe)).toThrow(/DOCTYPE/)
  })

  test("entities, CDATA and namespace prefixes read as plain text", () => {
    const doc = parseXml(
      "<d:feedback xmlns:d='urn:x'><d:org_name>A &amp; B &#x41;<![CDATA[<c>]]></d:org_name></d:feedback>",
    )
    expect(doc.children[0]!.name).toBe("feedback")
    expect(doc.children[0]!.children[0]!.text).toBe("A & B A<c>")
  })

  test("a Google-shaped aggregate report", () => {
    const report = parseAggregate(googleXml("example.com"))
    expect(report.orgName).toBe("google.com")
    expect(report.reportId).toBe("17282828282828282828")
    expect(report.policy).toMatchObject({ domain: "example.com", p: "quarantine", pct: 100 })
    expect(report.begin.getTime()).toBe(BEGIN * 1000)
    // The record with a source IP that does not parse is dropped, not stored.
    expect(report.records).toHaveLength(2)
    expect(report.records[0]).toMatchObject({
      sourceIp: "203.0.113.25",
      count: 12,
      dkimEval: "pass",
      dkim: [{ domain: "example.com", result: "pass", selector: "corsair-1" }],
    })
    expect(report.records[1]).toMatchObject({
      sourceIp: "2001:db8::7",
      disposition: "quarantine",
      envelopeFrom: "spoof.example",
    })
  })

  test("a report missing its identity is refused", () => {
    expect(() => parseAggregate("<feedback><report_metadata/></feedback>")).toThrow()
    expect(() => parseAggregate("<html></html>")).toThrow(/feedback/)
  })

  test("a Microsoft-shaped TLS report", () => {
    const report = parseTlsReport(microsoftJson("example.com"))
    expect(report.orgName).toBe("Microsoft Corporation")
    expect(report.policies).toHaveLength(2)
    expect(report.policies[0]).toMatchObject({
      policyType: "sts",
      policyDomain: "example.com",
      mxHost: "mx1.example.com",
      success: 41,
      failure: 2,
    })
    expect(report.policies[0]!.failures[0]).toMatchObject({
      result_type: "certificate-expired",
      receiving_ip: "203.0.113.25",
      failed_session_count: 2,
    })
    expect(() => parseTlsReport("{not json")).toThrow()
  })

  test("what this server builds, it can read back", () => {
    const xml = buildAggregate({
      orgName: "mail.corsair.local",
      email: "noreply-dmarc@mail.corsair.local",
      reportId: "r-1",
      begin: new Date("2026-10-27T00:00:00Z"),
      end: new Date("2026-10-27T23:59:59Z"),
      policy: { domain: "far.example", p: "reject", sp: null, pct: 100, adkim: "r", aspf: "s" },
      rows: [
        {
          source_ip: "198.51.100.4",
          count: 5,
          disposition: "none",
          header_from: "far.example",
          envelope_from: "bounce.far.example",
          spf_result: "pass",
          spf_domain: "bounce.far.example",
          spf_aligned: false,
          dkim_result: "pass",
          dkim_domain: "far.example",
          dkim_aligned: true,
        },
      ],
    })
    const back = parseAggregate(xml)
    expect(back.policy).toMatchObject({ domain: "far.example", p: "reject", aspf: "s" })
    expect(back.records[0]).toMatchObject({
      sourceIp: "198.51.100.4",
      count: 5,
      dkimEval: "pass",
      spfEval: "fail",
      envelopeFrom: "bounce.far.example",
    })

    const json = buildTlsReport({
      orgName: "mail.corsair.local",
      contact: "mailto:noreply-dmarc@mail.corsair.local",
      reportId: "t-1",
      begin: new Date("2026-10-27T00:00:00Z"),
      end: new Date("2026-10-27T23:59:59Z"),
      policyDomain: "far.example",
      rows: [
        {
          policy_type: "no-policy-found",
          mx_host: "mx.far.example",
          result: "success",
          detail: "",
          count: 9,
        },
        {
          policy_type: "no-policy-found",
          mx_host: "mx.far.example",
          result: "starttls-not-supported",
          detail: "",
          count: 1,
        },
        {
          policy_type: "tlsa",
          mx_host: "mx2.far.example",
          result: "success",
          detail: "",
          count: 4,
        },
        {
          policy_type: "tlsa",
          mx_host: "mx2.far.example",
          result: "certificate-host-mismatch",
          detail: "",
          count: 2,
        },
      ],
    })
    const tls = parseTlsReport(json)
    expect(tls.policies[0]).toMatchObject({
      policyType: "no-policy-found",
      success: 9,
      failure: 1,
    })
    // DANE sessions are reported under their own policy, not folded into the rest.
    expect(tls.policies[1]).toMatchObject({ policyType: "tlsa", success: 4, failure: 2 })
  })
})

// receiving

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `rpt-${suffix}.invalid`
const otherZone = `other-${suffix}.invalid`
let userId = ""
let strangerId = ""
let domain: Domain
let other: Domain

const ctx = { remoteIp: "127.0.0.1", local: true, helo: "mail-relay.google.invalid" }

const envelopeFor = (rcpt: string[]): Envelope => ({
  helo: ctx.helo,
  mailFrom: "noreply-dmarc-support@google.invalid",
  hasSender: true,
  rcptTo: rcpt,
  size: null,
  smtputf8: false,
})

const makeUser = async (label: string): Promise<string> => {
  const id = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Reports', $2) RETURNING id`,
    values: [`${label}-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id
  // The instance owner administers every domain, which is not what is under test.
  await db().execute({ text: "UPDATE users SET is_owner = false WHERE id = $1", values: [id] })
  return id
}

const app = buildFetch(null)
const callAs = async (user: string, path: string) =>
  app(
    new Request(`http://corsair.test${path}`, {
      headers: { cookie: `${SESSION_COOKIE}=${(await issueSession(user)).token}` },
    }),
  )

beforeAll(async () => {
  userId = await makeUser("reports")
  strangerId = await makeUser("stranger")
  const make = async (name: string) =>
    (await db().one<Domain>({
      text: `INSERT INTO domains (user_id, name, verification_token, status)
             VALUES ($1, $2, 'mail-host-verify=rpt', 'active') RETURNING *`,
      values: [userId, name],
    }))!
  domain = await make(zone)
  other = await make(otherZone)
})

afterAll(async () => {
  await db().execute({
    text: "DELETE FROM users WHERE id = ANY(SELECT jsonb_array_elements_text($1::jsonb)::uuid)",
    values: [[userId, strangerId]],
  })
  await db().execute({
    text: "DELETE FROM report_sends WHERE policy_domain LIKE $1",
    values: [`%${suffix}%`],
  })
  await db().execute({
    text: "DELETE FROM deliveries WHERE rcpt_to LIKE $1",
    values: [`%${suffix}%`],
  })
})

describe("receiving", () => {
  test("the report address is accepted with no mailbox behind it", async () => {
    expect(await validateRecipient(`dmarc-reports@${zone}`, null, envelopeFor([]))).toBeNull()
    expect(await validateRecipient(`tlsrpt@${zone}`, null, envelopeFor([]))).toBeNull()
    expect(
      (await validateRecipient(`dmarc-reports@nowhere-${suffix}.invalid`, null, envelopeFor([])))
        ?.code,
    ).toBe(550)
  })

  test("a gzipped report arriving over SMTP is filed under the domain", async () => {
    const raw = reportMail(`dmarc-reports@${zone}`, {
      type: "application/gzip",
      name: `google.com!${zone}!${BEGIN}!${BEGIN + 86399}.xml.gz`,
      content: gzipSync(Buffer.from(googleXml(zone, `gz-${suffix}`))),
    })
    const reply = await handleMessage(envelopeFor([`dmarc-reports@${zone}`]), raw, ctx)
    expect(reply.code).toBe(250)

    const summary = await dmarcSummary(domain.id, 3650)
    const report = summary.reports.find((r) => r.report_id === `gz-${suffix}`)
    expect(report).toMatchObject({ org_name: "google.com", message_count: 15, pass_count: 12 })
    const byIp = Object.fromEntries(summary.bySource.map((r) => [r.source_ip, Number(r.failed)]))
    expect(byIp["2001:db8::7"]).toBe(3)

    // The same report again is not counted twice.
    await handleMessage(envelopeFor([`dmarc-reports@${zone}`]), raw, ctx)
    const again = await dmarcSummary(domain.id, 3650)
    expect(again.reports.filter((r) => r.report_id === `gz-${suffix}`)).toHaveLength(1)
  })

  test("a zipped report about a subdomain is accepted", async () => {
    const { normalized, parsed } = parsedOf(
      reportMail(`dmarc-reports@${zone}`, {
        type: "application/zip",
        name: "report.zip",
        content: zip("report.xml", Buffer.from(googleXml(`news.${zone}`, `zip-${suffix}`))),
      }),
    )
    const outcome = await ingestReports(domain, normalized, parsed, true)
    expect(outcome).toEqual({ stored: 1, refused: [] })
  })

  test("a report about another domain is refused, even one on the same account", async () => {
    expect(coversDomain(otherZone, zone)).toBe(false)
    expect(coversDomain(`x${zone}`, zone)).toBe(false)
    expect(coversDomain(`a.${zone}`, zone)).toBe(true)

    const { normalized, parsed } = parsedOf(
      reportMail(`dmarc-reports@${zone}`, {
        type: "application/gzip",
        name: "r.xml.gz",
        content: gzipSync(Buffer.from(googleXml(otherZone, `cross-${suffix}`))),
      }),
    )
    const outcome = await ingestReports(domain, normalized, parsed, true)
    expect(outcome.stored).toBe(0)
    expect(outcome.refused[0]).toMatch(/not rpt-/)

    for (const d of [domain, other]) {
      const summary = await dmarcSummary(d.id, 3650)
      expect(summary.reports.some((r) => r.report_id === `cross-${suffix}`)).toBe(false)
    }
    await expect(storeDmarcReport(domain, parseAggregate(googleXml(otherZone)))).rejects.toThrow()
  })

  test("a report from a sender that did not authenticate is not filed", async () => {
    const { normalized, parsed } = parsedOf(
      reportMail(`dmarc-reports@${zone}`, {
        type: "text/xml",
        name: "r.xml",
        content: Buffer.from(googleXml(zone, `unauth-${suffix}`)),
      }),
    )
    const outcome = await ingestReports(domain, normalized, parsed, false)
    expect(outcome.stored).toBe(0)
  })

  test("a TLS report keeps only the entries about this domain", async () => {
    const { normalized, parsed } = parsedOf(
      reportMail(`tlsrpt@${zone}`, {
        type: "application/tlsrpt+gzip",
        name: "r.json.gz",
        content: gzipSync(Buffer.from(microsoftJson(zone, `tls-${suffix}`))),
      }),
    )
    expect(await ingestReports(domain, normalized, parsed, true)).toEqual({
      stored: 1,
      refused: [],
    })
    const summary = await tlsSummary(domain.id, 3650)
    const report = summary.reports.find((r) => r.report_id === `tls-${suffix}`)
    // someone-else.example's thousand sessions are not this domain's.
    expect(report).toMatchObject({ success_count: 41, failure_count: 2 })
    expect(summary.byResult.map((r) => r.result_type)).toContain("certificate-expired")
  })

  test("a report address that is a real mailbox still gets the message", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "tlsrpt",
      type: "standard",
      password: "hunter2hunter2",
    })
    const raw = reportMail(`tlsrpt@${zone}`, {
      type: "application/tlsrpt+json",
      name: "r.json",
      content: Buffer.from(microsoftJson(zone, `mbox-${suffix}`)),
    })
    expect((await handleMessage(envelopeFor([`tlsrpt@${zone}`]), raw, ctx)).code).toBe(250)
    // Which folder is the spam score's business; that it was delivered is ours.
    const stored = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM messages WHERE address_id = $1",
      values: [address.id],
    })
    expect(stored?.count).toBe("1")
    const summary = await tlsSummary(domain.id, 3650)
    expect(summary.reports.some((r) => r.report_id === `mbox-${suffix}`)).toBe(true)
  })
})

describe("the API", () => {
  test("the owner sees the domain's totals; anyone else gets a 404", async () => {
    const res = await callAs(userId, `/api/domains/${domain.id}/reports/dmarc?days=180`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.object).toBe("dmarc_summary")
    expect(body.by_reporter[0]).toMatchObject({ org_name: "google.com" })
    expect(typeof body.totals.messages).toBe("number")
    expect(body.by_source.some((r: { source_ip: string }) => r.source_ip === "2001:db8::7")).toBe(
      true,
    )

    const tls = await callAs(userId, `/api/domains/${domain.id}/reports/tls`)
    expect(tls.status).toBe(200)
    expect((await tls.json()).totals.succeeded).toBeGreaterThan(0)

    expect((await callAs(strangerId, `/api/domains/${domain.id}/reports/dmarc`)).status).toBe(404)
    expect((await callAs(strangerId, `/api/domains/${domain.id}/reports/tls`)).status).toBe(404)
    expect((await callAs(userId, `/api/domains/${domain.id}/reports/dmarc?days=999`)).status).toBe(
      422,
    )
  })
})

// sending

const far = `far-${suffix}.invalid`
const thirdParty = `analytics-${suffix}.invalid`

/** A resolver that knows only what the test says, and fails like DNS otherwise. */
const resolverFor = (records: Record<string, string[]>) => async (name: string) => {
  const found = records[name]
  if (!found) throw Object.assign(new Error(`queryTxt ENOTFOUND ${name}`), { code: "ENOTFOUND" })
  return found.map((r) => [r])
}

const rowsTo = (rcpt: string): Promise<Delivery[]> =>
  db().all<Delivery>({ text: "SELECT * FROM deliveries WHERE rcpt_to = $1", values: [rcpt] })

const attachmentOf = (delivery: Delivery): { type: string; data: Buffer; headers: string } => {
  const raw = inlineBody(delivery.storage_key!)!
  const parsed = mime.parseMessage(raw)
  const part = mime.attachmentParts(parsed)[0]!
  return {
    type: `${part.type}/${part.subtype}`,
    data: gunzipSync(mime.decodeTransfer(raw.slice(part.bodyStart, part.end), part.encoding)),
    headers: raw.slice(0, parsed.bodyStart),
  }
}

describe("sending", () => {
  const yesterday = new Date(Date.now() - 86_400_000)

  test("rua parsing keeps mailto addresses only, without size limits", () => {
    expect(
      mailtoDestinations([
        "mailto:dmarc@far.example!10m",
        "https://collector.example/dmarc",
        "mailto:Agg%2Breports@far.example",
        "mailto:bad address@far.example",
        "mailto:dmarc@far.example",
      ]),
    ).toEqual(["dmarc@far.example", "agg+reports@far.example"])
  })

  test("an external destination needs its own TXT record (RFC 7489 §7.1)", async () => {
    const asked: string[] = []
    const resolve = async (name: string) => {
      asked.push(name)
      return resolverFor({
        [`${far}._report._dmarc.${thirdParty}`]: ["v=DMARC1"],
        [`${far}._report._dmarc.liar.invalid`]: ["v=spf1 -all"],
      })(name)
    }
    // The policy domain itself and anything under it need no check.
    expect(await destinationAllowed(far, `dmarc@${far}`, resolve)).toBe(true)
    expect(await destinationAllowed(far, `dmarc@reports.${far}`, resolve)).toBe(true)
    expect(asked).toEqual([])
    expect(await destinationAllowed(far, `dmarc@${thirdParty}`, resolve)).toBe(true)
    expect(await destinationAllowed(far, "dmarc@liar.invalid", resolve)).toBe(false)
    expect(await destinationAllowed(far, "victim@stranger.invalid", resolve)).toBe(false)
    // A parent domain is somebody else until it says otherwise.
    expect(await destinationAllowed(`sub.${far}`, `dmarc@${far}`, resolve)).toBe(false)
  })

  test("a day's outcomes become one aggregate report, and only verified destinations get it", async () => {
    const observe = (sourceIp: string, spf: string, dkimAligned: boolean) =>
      recordDmarc(
        {
          policy: {
            domain: far,
            rua: [`mailto:dmarc@${far}`, `mailto:agg@${thirdParty}`, "mailto:x@unverified.invalid"],
          },
          headerFrom: far,
          sourceIp,
          envelopeFrom: `bounce@${far}`,
          spf: { result: spf, domain: far, aligned: true },
          dkim: {
            result: dkimAligned ? "pass" : "none",
            domain: dkimAligned ? far : null,
            aligned: dkimAligned,
          },
          disposition: "none",
        },
        yesterday,
      )
    await observe("198.51.100.1", "pass", true)
    await observe("198.51.100.1", "pass", true)
    await observe("198.51.100.1", "pass", true)
    await observe("192.0.2.66", "fail", false)

    const resolve = resolverFor({
      [`_dmarc.${far}`]: [
        `v=DMARC1; p=reject; rua=mailto:dmarc@${far},mailto:agg@${thirdParty},mailto:x@unverified.invalid`,
      ],
      [`${far}._report._dmarc.${thirdParty}`]: ["v=DMARC1;"],
    })
    const result = await runReports({ resolve })
    expect(result.dmarc).toBeGreaterThanOrEqual(1)

    const mine = await rowsTo(`dmarc@${far}`)
    expect(mine).toHaveLength(1)
    expect(await rowsTo(`agg@${thirdParty}`)).toHaveLength(1)
    expect(await rowsTo("x@unverified.invalid")).toHaveLength(0)
    expect(mine[0]!.mail_from).toBe(`noreply-dmarc@${config.hostname}`)

    const attached = attachmentOf(mine[0]!)
    expect(attached.type).toBe("application/gzip")
    expect(attached.headers).toContain(`Report Domain: ${far}`)
    const report = parseAggregate(attached.data.toString("utf8"))
    expect(report.policy).toMatchObject({ domain: far, p: "reject" })
    expect(report.begin.toISOString().slice(0, 10)).toBe(utcDay(yesterday))
    const byIp = Object.fromEntries(report.records.map((r) => [r.sourceIp, r]))
    expect(byIp["198.51.100.1"]).toMatchObject({ count: 3, dkimEval: "pass", spfEval: "pass" })
    expect(byIp["192.0.2.66"]).toMatchObject({ count: 1, dkimEval: "fail", spfEval: "fail" })

    // The rows behind it are gone, and running again sends nothing new.
    const left = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM dmarc_evaluations WHERE policy_domain = $1",
      values: [far],
    })
    expect(left?.count).toBe("0")
    await runReports({ resolve })
    expect(await rowsTo(`dmarc@${far}`)).toHaveLength(1)
  })

  test("a domain with no rua is never recorded", async () => {
    await recordDmarc(
      {
        policy: { domain: `quiet-${suffix}.invalid`, rua: [] },
        headerFrom: `quiet-${suffix}.invalid`,
        sourceIp: "198.51.100.9",
        envelopeFrom: "",
        spf: { result: "pass", domain: "x", aligned: false },
        dkim: { result: "none", domain: null, aligned: false },
        disposition: "none",
      },
      yesterday,
    )
    const row = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM dmarc_evaluations WHERE policy_domain = $1",
      values: [`quiet-${suffix}.invalid`],
    })
    expect(row?.count).toBe("0")
  })

  test("TLS outcomes become an RFC 8460 report by mail and by HTTPS", async () => {
    const tlsDomain = `tls-${suffix}.invalid`
    await recordTls(
      tlsDomain,
      [
        { host: `mx1.${tlsDomain}`, policy: "no-policy-found", result: "success", detail: "" },
        { host: `mx1.${tlsDomain}`, policy: "no-policy-found", result: "success", detail: "" },
        {
          host: `mx2.${tlsDomain}`,
          policy: "no-policy-found",
          result: "starttls-not-supported",
          detail: "",
        },
      ],
      yesterday,
    )
    const resolve = resolverFor({
      [`_smtp._tls.${tlsDomain}`]: [
        `v=TLSRPTv1; rua=mailto:tls@${tlsDomain},https://collector.${tlsDomain}/v1`,
      ],
    })
    expect(await lookupTlsRpt(tlsDomain, resolve)).toEqual([
      `mailto:tls@${tlsDomain}`,
      `https://collector.${tlsDomain}/v1`,
    ])

    const posted: { url: string; body: Buffer }[] = []
    await runReports({
      resolve,
      post: async (url, body) => {
        posted.push({ url, body })
        return { ok: true, status: 200 }
      },
    })

    const rows = await rowsTo(`tls@${tlsDomain}`)
    expect(rows).toHaveLength(1)
    const attached = attachmentOf(rows[0]!)
    expect(attached.type).toBe("application/tlsrpt+gzip")
    expect(attached.headers).toContain(`TLS-Report-Domain: ${tlsDomain}`)
    expect(attached.headers).toMatch(/report-type="tlsrpt"/)
    const report = parseTlsReport(attached.data.toString("utf8"))
    expect(report.policies[0]).toMatchObject({ policyDomain: tlsDomain, success: 2, failure: 1 })

    expect(posted).toHaveLength(1)
    expect(parseTlsReport(gunzipSync(posted[0]!.body).toString()).reportId).toBe(report.reportId)
  })

  test("a day with nowhere to send is settled and its rows removed", async () => {
    const stale = `stale-${suffix}.invalid`
    await recordTls(
      stale,
      [{ host: `mx.${stale}`, policy: "no-policy-found", result: "success", detail: "" }],
      yesterday,
    )
    await runReports({ resolve: resolverFor({}) })
    const row = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM tls_outcomes WHERE policy_domain = $1",
      values: [stale],
    })
    expect(row?.count).toBe("0")
    const claim = await db().one<{ status: string }>({
      text: "SELECT status FROM report_sends WHERE kind = 'tlsrpt' AND policy_domain = $1",
      values: [stale],
    })
    expect(claim?.status).toBe("skipped")
  })
})
