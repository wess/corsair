import { useEffect, useState } from "react"
import { Banner, Card, ErrorText, Icon, icons, Loading, useLoad } from "../components/index.tsx"
import { formatDate, get } from "../lib/api.ts"

/**
 * DMARC aggregate and TLS reports other mail servers sent about a domain.
 *
 * Answers two questions: who is sending mail as this domain, and does it pass;
 * and can other servers reach this one over TLS. The reports arrive at
 * `dmarc-reports@` and `tlsrpt@` on the domain, which the recommended DNS
 * records already name.
 */

type DomainItem = { id: string; name: string }

type DmarcSummary = {
  days: number
  totals: { reports: number; messages: number; passed: number; failed: number }
  by_source: {
    source_ip: string
    messages: number
    passed: number
    failed: number
    reporters: string[]
  }[]
  by_reporter: {
    org_name: string
    reports: number
    messages: number
    passed: number
    failed: number
  }[]
  reports: {
    id: string
    org_name: string
    report_id: string
    policy_domain: string
    date_begin: string
    date_end: string
    messages: number
    passed: number
    failed: number
  }[]
}

type TlsSummary = {
  days: number
  totals: { reports: number; succeeded: number; failed: number }
  by_reporter: { org_name: string; reports: number; succeeded: number; failed: number }[]
  by_result: { result_type: string; sessions: number }[]
  reports: {
    id: string
    org_name: string
    report_id: string
    date_begin: string
    date_end: string
    succeeded: number
    failed: number
  }[]
}

const WINDOWS = [7, 30, 90, 180]

const percent = (part: number, whole: number) =>
  whole ? `${Math.round((part / whole) * 1000) / 10}%` : "—"

const Stat = ({ value, label, tone }: { value: string | number; label: string; tone?: string }) => (
  <div>
    <div className="stat" style={tone ? { color: `var(--${tone})` } : undefined}>
      {value}
    </div>
    <div className="stat-label">{label}</div>
  </div>
)

const DmarcSection = ({ domainId, days }: { domainId: string; days: number }) => {
  const { data, error, loading } = useLoad(
    () => get<DmarcSummary>(`/api/domains/${domainId}/reports/dmarc?days=${days}`),
    [domainId, days],
  )
  if (loading) return <Loading />
  if (error) return <ErrorText error={error} />
  if (!data) return null

  if (!data.totals.reports) {
    return (
      <Card title="DMARC">
        <Banner>
          <Icon path={icons.docs} size={15} />
          <span>
            No DMARC reports in this window. They arrive once the domain's DMARC record carries{" "}
            <code>rua=mailto:dmarc-reports@</code> and other servers have received its mail.
          </span>
        </Banner>
      </Card>
    )
  }

  return (
    <>
      <Card title="DMARC">
        <div className="row" style={{ gap: 28 }}>
          <Stat value={data.totals.messages} label="Messages reported" />
          <Stat value={data.totals.passed} label="Passed" tone="good" />
          <Stat value={data.totals.failed} label="Failed" tone="bad" />
          <Stat value={percent(data.totals.passed, data.totals.messages)} label="Pass rate" />
          <Stat value={data.totals.reports} label="Reports" />
        </div>
      </Card>

      <Card title="By sending IP" bodyless>
        <table>
          <thead>
            <tr>
              <th>Source IP</th>
              <th>Messages</th>
              <th>Passed</th>
              <th>Failed</th>
              <th>Reported by</th>
            </tr>
          </thead>
          <tbody>
            {data.by_source.map((row) => (
              <tr key={row.source_ip}>
                <td className="mono">{row.source_ip}</td>
                <td>{row.messages}</td>
                <td>{row.passed}</td>
                <td style={row.failed ? { color: "var(--bad)" } : undefined}>{row.failed}</td>
                <td className="muted">{row.reporters.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="grid grid-2">
        <Card title="By reporter" bodyless>
          <table>
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Reports</th>
                <th>Messages</th>
                <th>Pass rate</th>
              </tr>
            </thead>
            <tbody>
              {data.by_reporter.map((row) => (
                <tr key={row.org_name}>
                  <td>{row.org_name}</td>
                  <td>{row.reports}</td>
                  <td>{row.messages}</td>
                  <td>{percent(row.passed, row.messages)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Recent reports" bodyless>
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>Covering</th>
                <th>Messages</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              {data.reports.slice(0, 20).map((r) => (
                <tr key={r.id}>
                  <td>
                    <div>{r.org_name}</div>
                    {r.policy_domain && <div className="muted">{r.policy_domain}</div>}
                  </td>
                  <td>{formatDate(r.date_end)}</td>
                  <td>{r.messages}</td>
                  <td>{r.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>
    </>
  )
}

const TlsSection = ({ domainId, days }: { domainId: string; days: number }) => {
  const { data, error, loading } = useLoad(
    () => get<TlsSummary>(`/api/domains/${domainId}/reports/tls?days=${days}`),
    [domainId, days],
  )
  if (loading) return <Loading />
  if (error) return <ErrorText error={error} />
  if (!data) return null

  if (!data.totals.reports) {
    return (
      <Card title="TLS reporting">
        <Banner>
          <Icon path={icons.docs} size={15} />
          <span>
            No TLS reports in this window. They arrive once <code>_smtp._tls</code> is published
            with <code>rua=mailto:tlsrpt@</code>.
          </span>
        </Banner>
      </Card>
    )
  }

  const total = data.totals.succeeded + data.totals.failed
  return (
    <>
      <Card title="TLS reporting">
        <div className="row" style={{ gap: 28 }}>
          <Stat value={data.totals.succeeded} label="TLS sessions" tone="good" />
          <Stat value={data.totals.failed} label="Failed sessions" tone="bad" />
          <Stat value={percent(data.totals.succeeded, total)} label="Success rate" />
          <Stat value={data.totals.reports} label="Reports" />
        </div>
      </Card>

      <div className="grid grid-2">
        <Card title="By reporter" bodyless>
          <table>
            <thead>
              <tr>
                <th>Organisation</th>
                <th>Reports</th>
                <th>Succeeded</th>
                <th>Failed</th>
              </tr>
            </thead>
            <tbody>
              {data.by_reporter.map((row) => (
                <tr key={row.org_name}>
                  <td>{row.org_name}</td>
                  <td>{row.reports}</td>
                  <td>{row.succeeded}</td>
                  <td>{row.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Failures by type" bodyless>
          {data.by_result.length ? (
            <table>
              <thead>
                <tr>
                  <th>Result</th>
                  <th>Sessions</th>
                </tr>
              </thead>
              <tbody>
                {data.by_result.map((row) => (
                  <tr key={row.result_type}>
                    <td className="mono">{row.result_type}</td>
                    <td>{row.sessions}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="card-body muted">No failures reported.</div>
          )}
        </Card>
      </div>
    </>
  )
}

export const ReportsPage = () => {
  const domains = useLoad(() => get<{ data: DomainItem[] }>("/api/domains?per_page=100"))
  const [domainId, setDomainId] = useState("")
  const [days, setDays] = useState(30)

  useEffect(() => {
    const first = domains.data?.data[0]
    if (first && !domainId) setDomainId(first.id)
  }, [domains.data, domainId])

  if (domains.loading) return <Loading />
  if (domains.error) return <ErrorText error={domains.error} />
  const list = domains.data?.data ?? []

  return (
    <div className="page">
      <div className="row" style={{ gap: 12 }}>
        <select
          aria-label="Domain"
          value={domainId}
          onChange={(e) => setDomainId(e.target.value)}
          style={{ maxWidth: 320 }}
        >
          {list.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Window"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          style={{ maxWidth: 160 }}
        >
          {WINDOWS.map((w) => (
            <option key={w} value={w}>
              Last {w} days
            </option>
          ))}
        </select>
      </div>

      {list.length === 0 ? (
        <Banner>
          <Icon path={icons.domains} size={15} />
          <span>Add a domain first. Reports are about the mail sent as one.</span>
        </Banner>
      ) : domainId ? (
        <>
          <DmarcSection domainId={domainId} days={days} />
          <TlsSection domainId={domainId} days={days} />
        </>
      ) : null}
    </div>
  )
}
