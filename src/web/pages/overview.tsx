import { navigate } from "../app.tsx"
import {
  Banner,
  Card,
  Copyable,
  ErrorText,
  Icon,
  icons,
  Loading,
  Pill,
  Sparkline,
  useLoad,
} from "../components/index.tsx"
import { formatBytes, formatDate, get } from "../lib/api.ts"

type Overview = {
  activity: {
    sent: number
    received: number
    days: { day: string; sent: number; received: number }[]
  }
  usage: {
    bytes_used: number
    storage_bytes: number
    used_label: string
    limit_label: string
    percent: number
  }
  top_senders: { email: string; sent: number }[]
  entitlement: {
    plan: { name: string; storage_bytes: number; daily_in: number; daily_out: number }
    subscription: {
      status: string
      current_period_end: string
      cancel_at_period_end: boolean
    } | null
    usage: { sent_today: number; received_today: number; daily_in: number; daily_out: number }
  }
  pending_domains: { id: string; name: string }[]
  mail_hosts: Record<string, { host: string; port: number; security: string }>
}

export const OverviewPage = ({ name }: { name: string | null }) => {
  const { data, error, loading } = useLoad(() => get<Overview>("/api/overview"))

  if (loading) return <Loading />
  if (error) return <ErrorText error={error} />
  if (!data) return null

  const { entitlement } = data

  return (
    <div className="page">
      <h2 style={{ margin: 0, fontWeight: 600, letterSpacing: "-0.02em" }}>
        {name ? `Hey ${name.split(" ")[0]},` : "Hello,"}{" "}
        <span className="muted">here are your latest statistics.</span>
      </h2>

      {data.pending_domains.length > 0 && (
        <Banner kind="warn">
          <Icon path={icons.warn} size={16} />
          <span>
            {data.pending_domains.length === 1
              ? `${data.pending_domains[0]!.name} is not verified yet — mail cannot be sent from it.`
              : `${data.pending_domains.length} domains are not verified yet.`}{" "}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => navigate(`/domains/${data.pending_domains[0]!.id}?tab=dns`)}
            >
              Finish DNS setup
            </button>
          </span>
        </Banner>
      )}

      <div className="grid grid-2">
        <Card title="Recent activity">
          <div className="row" style={{ gap: 20, marginBottom: 10 }}>
            <div>
              <div className="stat" style={{ color: "var(--good)" }}>
                {data.activity.sent}
              </div>
              <div className="stat-label">Sent</div>
            </div>
            <div>
              <div className="stat" style={{ color: "var(--accent)" }}>
                {data.activity.received}
              </div>
              <div className="stat-label">Received</div>
            </div>
            <div className="faint" style={{ marginLeft: "auto", fontSize: 13 }}>
              last 30 days
            </div>
          </div>
          <Sparkline days={data.activity.days} />
        </Card>

        <Card title="Data usage">
          <div style={{ textAlign: "center", padding: "8px 0 16px" }}>
            <div className="stat" style={{ fontSize: 44 }}>
              {data.usage.used_label}
            </div>
            <div className="stat-label">used of {data.usage.limit_label}</div>
          </div>
          <div className="meter">
            <span style={{ width: `${data.usage.percent}%` }} />
          </div>
          <div className="row spread" style={{ marginTop: 14 }}>
            <span className="muted">Today</span>
            <span className="mono">
              {entitlement.usage.received_today} in
              {entitlement.usage.daily_in ? ` / ${entitlement.usage.daily_in}` : ""} ·{" "}
              {entitlement.usage.sent_today} out
              {entitlement.usage.daily_out ? ` / ${entitlement.usage.daily_out}` : ""}
            </span>
          </div>
        </Card>
      </div>

      <div className="grid grid-2">
        <Card title="Highest sending by address" bodyless>
          <table>
            <thead>
              <tr>
                <th>Address</th>
                <th>Sent</th>
              </tr>
            </thead>
            <tbody>
              {data.top_senders.length === 0 && (
                <tr>
                  <td colSpan={2} className="empty">
                    No addresses yet.
                  </td>
                </tr>
              )}
              {data.top_senders.map((sender) => (
                <tr key={sender.email}>
                  <td className="mono truncate">{sender.email}</td>
                  <td>{sender.sent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Plan, account & billing">
          <div className="row spread" style={{ marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 650 }}>{entitlement.plan.name}</div>
              <div className="muted">
                {formatBytes(entitlement.plan.storage_bytes)} · {entitlement.plan.daily_in || "∞"}{" "}
                in / {entitlement.plan.daily_out || "∞"} out per day
              </div>
            </div>
            <Pill kind={entitlement.subscription?.status === "active" ? "good" : "warn"}>
              {entitlement.subscription?.status ?? "no subscription"}
            </Pill>
          </div>

          {entitlement.subscription && (
            <div className="row spread">
              <span className="muted">
                {entitlement.subscription.cancel_at_period_end ? "Ends on" : "Renews on"}
              </span>
              <span>{formatDate(entitlement.subscription.current_period_end)}</span>
            </div>
          )}

          <div className="row" style={{ marginTop: 16 }}>
            <button type="button" className="btn btn-sm" onClick={() => navigate("/plans")}>
              Change plan
            </button>
            <button type="button" className="btn btn-sm" onClick={() => navigate("/billing")}>
              Billing
            </button>
          </div>
        </Card>
      </div>

      <Card title="Connect a mail client">
        <div className="grid grid-2">
          {Object.entries(data.mail_hosts).map(([key, server]) => (
            <div key={key} className="row spread">
              <span className="muted">
                {key.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase())}
              </span>
              <Copyable value={`${server.host}:${server.port}`} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
