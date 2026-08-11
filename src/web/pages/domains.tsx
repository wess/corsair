import { useState } from "react"
import { navigate } from "../app.tsx"
import {
  Banner,
  Card,
  Copyable,
  DataTable,
  Dialog,
  ErrorText,
  Field,
  Icon,
  icons,
  Loading,
  Pill,
  Sparkline,
  Spinner,
  statusPill,
  useLoad,
} from "../components/index.tsx"
import {
  del,
  formatBytes,
  generatePassword,
  get,
  type Page,
  patch,
  post,
  qs,
  RequestError,
} from "../lib/api.ts"

type Domain = {
  id: string
  name: string
  status: string
  bytes_used: number
  verification_token?: string
  dmarc_policy?: string
  self_service_enabled?: boolean
  fallback_domain?: { id: string; name: string } | null
  address_count?: number
  records?: DomainRecord[]
  last_checked_at?: string | null
}

type DomainRecord = {
  id: string
  purpose: string
  type: string
  host: string
  value: string
  priority: number | null
  required: boolean
  status: string
  observed: string | null
}

type Address = {
  id: string
  local_part: string
  email: string
  type: string
  name: string | null
  bytes_used: number
  destinations: string[]
  filter_id: string | null
  filter_name: string | null
  recovery_address: string | null
  disabled: boolean
  uses_account_password: boolean
  last_login_at: string | null
}

const TYPE_LABEL: Record<string, string> = {
  standard: "Standard",
  alias: "Alias",
  catchall: "Catch-All",
  group: "Group",
}

// ------------------------------------------------------------------- list --

export const DomainsPage = () => {
  const [query, setQuery] = useState({
    search: "",
    sort: "name" as string | null,
    direction: "asc" as "asc" | "desc",
    page: 1,
    perPage: 10,
  })
  const [creating, setCreating] = useState(false)

  const { data, error, loading, reload } = useLoad(
    () =>
      get<Page<Domain>>(
        `/api/domains${qs({
          search: query.search,
          sort: query.sort,
          direction: query.direction,
          page: query.page,
          per_page: query.perPage,
        })}`,
      ),
    [query.search, query.sort, query.direction, query.page, query.perPage],
  )

  return (
    <div className="page">
      <ErrorText error={error} />

      <DataTable<Domain>
        columns={[
          {
            key: "name",
            label: "Domain",
            sortable: true,
            render: (d) => <strong>{d.name}</strong>,
          },
          {
            key: "data_usage",
            label: "Data usage",
            sortable: true,
            render: (d) => <span className="muted">{formatBytes(d.bytes_used)}</span>,
          },
          { key: "status", label: "Status", sortable: true, render: (d) => statusPill(d.status) },
        ]}
        page={data}
        loading={loading}
        query={query}
        onQuery={(next) => setQuery((q) => ({ ...q, ...next }))}
        emptyText="No domains yet. Add one to start receiving mail."
        onRowClick={(d) => navigate(`/domains/${d.id}`)}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon path={icons.plus} size={15} /> New domain
          </button>
        }
      />

      {creating && (
        <AddDomainDialog
          onClose={() => setCreating(false)}
          onCreated={(domain) => {
            setCreating(false)
            reload()
            navigate(`/domains/${domain.id}?tab=dns`)
          }}
        />
      )}
    </div>
  )
}

const AddDomainDialog = ({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (domain: Domain) => void
}) => {
  const [name, setName] = useState("")
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Dialog title="Add a new domain" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            onCreated(await post<Domain>("/api/domains", { name }))
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="Domain name"
          hint='Do not include a subdomain such as "www" unless you know you need it.'
        >
          <input
            required
            placeholder="example.com"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </Field>
        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner /> : "Add domain"}
        </button>
      </form>
    </Dialog>
  )
}

// ----------------------------------------------------------------- detail --

const TABS = [
  { key: "mailboxes", label: "Mailboxes" },
  { key: "fallback", label: "Fallback domain" },
  { key: "dns", label: "DNS setup" },
  { key: "client", label: "Client configuration" },
  { key: "self-service", label: "User self service" },
] as const

export const DomainDetailPage = ({ id }: { id: string }) => {
  const params = new URLSearchParams(window.location.search)
  const [tab, setTab] = useState<string>(params.get("tab") ?? "mailboxes")
  const { data, error, loading, reload } = useLoad(() => get<Domain>(`/api/domains/${id}`), [id])

  if (loading) return <Loading />
  if (error) return <ErrorText error={error} />
  if (!data) return null

  return (
    <div className="page">
      <div className="row">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate("/domains")}>
          <Icon path={icons.back} size={15} />
        </button>
        <h2 style={{ margin: 0, fontWeight: 650, letterSpacing: "-0.02em" }}>{data.name}</h2>
        {statusPill(data.status)}
      </div>

      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            className={`tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "mailboxes" && <MailboxesTab domain={data} />}
      {tab === "fallback" && <FallbackTab domain={data} onSaved={reload} />}
      {tab === "dns" && <DnsTab domain={data} onChecked={reload} />}
      {tab === "client" && <ClientConfigTab />}
      {tab === "self-service" && <SelfServiceTab domain={data} onSaved={reload} />}
    </div>
  )
}

// -------------------------------------------------------------- mailboxes --

const MailboxesTab = ({ domain }: { domain: Domain }) => {
  const [query, setQuery] = useState({
    search: "",
    sort: "mailbox" as string | null,
    direction: "asc" as "asc" | "desc",
    page: 1,
    perPage: 10,
  })
  const [creating, setCreating] = useState(false)

  const { data, loading, error, reload } = useLoad(
    () =>
      get<Page<Address>>(
        `/api/domains/${domain.id}/addresses${qs({
          search: query.search,
          sort: query.sort,
          direction: query.direction,
          page: query.page,
          per_page: query.perPage,
        })}`,
      ),
    [domain.id, query.search, query.sort, query.direction, query.page, query.perPage],
  )

  return (
    <>
      <ErrorText error={error} />
      <DataTable<Address>
        columns={[
          {
            key: "mailbox",
            label: "Mailbox",
            sortable: true,
            render: (a) => (
              <>
                <strong>{a.email}</strong>
                {a.disabled && (
                  <>
                    {" "}
                    <Pill kind="bad">disabled</Pill>
                  </>
                )}
              </>
            ),
          },
          {
            key: "type",
            label: "Type",
            sortable: true,
            render: (a) => (
              <span className="muted">
                {TYPE_LABEL[a.type] ?? a.type}
                {a.destinations.length > 0 && ` → ${a.destinations.join(", ")}`}
              </span>
            ),
          },
          {
            key: "data_usage",
            label: "Data usage",
            sortable: true,
            render: (a) => <span className="muted">{formatBytes(a.bytes_used)}</span>,
          },
        ]}
        page={data}
        loading={loading}
        query={query}
        onQuery={(next) => setQuery((q) => ({ ...q, ...next }))}
        emptyText="No addresses on this domain yet."
        onRowClick={(a) => navigate(`/addresses/${a.id}`)}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon path={icons.plus} size={15} /> New mailbox
          </button>
        }
      />

      {creating && (
        <CreateAddressDialog
          domain={domain}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            reload()
          }}
        />
      )}
    </>
  )
}

const CreateAddressDialog = ({
  domain,
  onClose,
  onCreated,
}: {
  domain: Domain
  onClose: () => void
  onCreated: () => void
}) => {
  const [type, setType] = useState<"standard" | "alias" | "catchall" | "group">("standard")
  const [localPart, setLocalPart] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [destinations, setDestinations] = useState("")
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const needsDestinations = type === "alias" || type === "group"
  const isMailbox = type === "standard" || type === "catchall"

  // Whether the mailbox being created is the account holder's own. It signs in
  // with the account password, so asking for a second one here would create a
  // credential that never works. Fetched rather than threaded through the page
  // — one request when a dialog opens is cheaper than the prop.
  const { data: account } = useLoad(() => get<{ email: string }>("/api/auth/me"))
  const isOwnMailbox =
    isMailbox &&
    Boolean(account?.email) &&
    `${localPart.trim().toLowerCase()}@${domain.name.toLowerCase()}` ===
      account?.email.toLowerCase()

  // Explicit opt-in, for the ordinary case where the panel sign-in address and
  // the mailbox address are simply different. The automatic match only fires
  // when they are identical, which yours often will not be.
  const [useAccountPassword, setUseAccountPassword] = useState(false)
  const sharesAccountPassword = isMailbox && (isOwnMailbox || useAccountPassword)
  const needsPassword = isMailbox && !sharesAccountPassword

  const description: Record<typeof type, string> = {
    standard: "A standard address with a mailbox.",
    alias: "An address that forwards mail to another address.",
    catchall: "A mailbox that catches mail sent to nonexistent addresses.",
    group: "A special alias that forwards mail to multiple recipients.",
  }

  return (
    <Dialog title="Create a new address" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await post(`/api/domains/${domain.id}/addresses`, {
              local_part: localPart,
              type,
              name: name || null,
              password: needsPassword ? password : null,
              use_account_password: sharesAccountPassword,
              destinations: needsDestinations
                ? destinations
                    .split(/[,\n]/)
                    .map((d) => d.trim())
                    .filter(Boolean)
                : undefined,
            })
            onCreated()
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Mailbox type" hint={description[type]}>
          <div className="segmented">
            {(["standard", "alias", "catchall", "group"] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={type === t ? "active" : ""}
                onClick={() => setType(t)}
              >
                {TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Address">
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              required
              value={localPart}
              onChange={(e) => setLocalPart(e.target.value)}
              placeholder="me"
            />
            <span className="muted mono">@{domain.name}</span>
          </div>
        </Field>

        <Field label="Name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="name to display as sender"
          />
        </Field>

        {isOwnMailbox && (
          <div style={{ marginBottom: 14 }}>
            <Banner kind="good">
              <Icon path={icons.check} size={15} />
              <span>
                This is your own address, so it signs in with your account password. No second
                password to set or remember.
              </span>
            </Banner>
          </div>
        )}

        {isMailbox && !isOwnMailbox && (
          <Field
            label="Password"
            hint="A mailbox you keep can use your account password. One you hand to someone else needs its own — a mailbox password never opens this panel."
          >
            <label className="row" style={{ gap: 8, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={useAccountPassword}
                onChange={(e) => setUseAccountPassword(e.target.checked)}
              />
              <span>This mailbox is mine — sign in with my account password</span>
            </label>
          </Field>
        )}

        {needsPassword && (
          <Field label="Password" hint="This is what a mail client signs in with.">
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input
                required
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowPassword(!showPassword)}
              >
                <Icon path={icons.eye} size={14} />
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setPassword(generatePassword())
                  setShowPassword(true)
                }}
              >
                Generate
              </button>
            </div>
          </Field>
        )}

        {needsDestinations && (
          <Field
            label={type === "alias" ? "Destination" : "Recipients"}
            hint={
              type === "alias"
                ? "One address. Use a group to forward to several."
                : "One per line, or comma separated."
            }
          >
            {type === "alias" ? (
              <input
                required
                type="email"
                value={destinations}
                onChange={(e) => setDestinations(e.target.value)}
              />
            ) : (
              <textarea
                required
                style={{ minHeight: 90 }}
                value={destinations}
                onChange={(e) => setDestinations(e.target.value)}
              />
            )}
          </Field>
        )}

        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner /> : "Create address"}
        </button>
      </form>
    </Dialog>
  )
}

// --------------------------------------------------------------- fallback --

const FallbackTab = ({ domain, onSaved }: { domain: Domain; onSaved: () => void }) => {
  const [value, setValue] = useState(domain.fallback_domain?.name ?? "")
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const gated = error instanceof RequestError && error.needsUpgrade

  return (
    <Card title="Assign a fallback domain">
      {gated && (
        <div style={{ marginBottom: 14 }}>
          <Banner kind="warn">
            <Icon path={icons.warn} size={15} />
            <span>
              Your current plan does not include fallback domains.{" "}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => navigate("/plans")}
              >
                Upgrade your plan
              </button>
            </span>
          </Banner>
        </div>
      )}

      <p className="muted" style={{ marginTop: 0 }}>
        When mail arrives that does not match any address in this domain, it is redirected to the
        fallback domain for further processing. Useful when several domains represent one canonical
        domain.
      </p>

      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await post(`/api/domains/${domain.id}/fallback`, { fallback_domain: value || null })
            onSaved()
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="Fallback domain"
          hint="Another domain on this account. Leave empty to remove."
        >
          <input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="example.com"
          />
        </Field>
        {!gated && <ErrorText error={error} />}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner /> : "Assign fallback"}
        </button>
      </form>
    </Card>
  )
}

// -------------------------------------------------------------------- DNS --

const PURPOSE_LABEL: Record<string, string> = {
  verification: "Verification",
  spf: "SPF",
  dmarc: "DMARC",
  dkim: "DKIM/ARC key",
  mta_sts: "MTA-STS",
  autoconfig: "Thunderbird autoconfig",
  autodiscover: "Outlook autodiscover",
  mx: "Mail exchange",
}

const DnsTab = ({ domain, onChecked }: { domain: Domain; onChecked: () => void }) => {
  const [checking, setChecking] = useState(false)
  const [result, setResult] = useState<{ ready: boolean } | null>(null)
  const [error, setError] = useState<unknown>(null)

  const { data, loading, reload } = useLoad(
    () =>
      get<{ records: DomainRecord[]; last_checked_at: string | null }>(
        `/api/domains/${domain.id}/dns`,
      ),
    [domain.id],
  )

  const check = async () => {
    setChecking(true)
    setError(null)
    try {
      const outcome = await post<{ ready: boolean }>(`/api/domains/${domain.id}/check`)
      setResult(outcome)
      reload()
      onChecked()
    } catch (e) {
      setError(e)
    } finally {
      setChecking(false)
    }
  }

  if (loading) return <Loading />

  return (
    <>
      <AutomaticSetup
        domain={domain}
        onPublished={() => {
          reload()
          onChecked()
        }}
      />

      <Card
        title="Manual setup"
        actions={
          <div className="row">
            <a className="btn btn-sm" href={`/api/domains/${domain.id}/dns/zone`}>
              <Icon path={icons.download} size={14} /> Export zone file
            </a>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={check}
              disabled={checking}
            >
              {checking ? <Spinner /> : <Icon path={icons.refresh} size={14} />} Check DNS
            </button>
          </div>
        }
        bodyless
      >
        <div className="card-body" style={{ paddingBottom: 0 }}>
          <p className="muted" style={{ marginTop: 0 }}>
            Publish these records with your DNS provider. Once they resolve, run the check to
            activate the domain.
          </p>
          {result && (
            <Banner kind={result.ready ? "good" : "warn"}>
              <Icon path={result.ready ? icons.check : icons.warn} size={15} />
              <span>
                {result.ready
                  ? "Every required record is in place. This domain is active."
                  : "Some records are still missing or do not match. DNS can take a while to propagate."}
              </span>
            </Banner>
          )}
          <ErrorText error={error} />
        </div>

        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Name / host</th>
              <th>Value</th>
              <th>Purpose</th>
            </tr>
          </thead>
          <tbody>
            {data?.records.map((record) => (
              <tr key={record.id}>
                <td className="mono">{record.type}</td>
                <td>
                  <Copyable
                    value={record.host}
                    label={record.host === "@" ? "empty or @" : record.host}
                  />
                </td>
                <td style={{ maxWidth: 340 }}>
                  <Copyable
                    value={record.priority ? `${record.priority} ${record.value}` : record.value}
                  />
                </td>
                <td>
                  <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                    <span className="muted">{PURPOSE_LABEL[record.purpose] ?? record.purpose}</span>
                    {!record.required && <Pill>optional</Pill>}
                    {statusPill(record.status)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {data?.records.some((r) => r.status !== "ok" && r.observed) && (
        <Card title="What we actually see">
          {data.records
            .filter((r) => r.status !== "ok" && r.observed)
            .map((r) => (
              <div key={r.id} className="field">
                <div className="label-text">
                  {r.type} {r.host}
                </div>
                <div className="mono faint" style={{ wordBreak: "break-all" }}>
                  {r.observed}
                </div>
              </div>
            ))}
        </Card>
      )}
    </>
  )
}

/**
 * One-click publishing.
 *
 * The alternative is a customer copying ten records by hand, which is where
 * most of them give up. The API token is sent once, used once, and never
 * stored — a DNS token can usually rewrite every record on every domain in an
 * account, and holding one to save a paste is a bad trade.
 */
const AutomaticSetup = ({ domain, onPublished }: { domain: Domain; onPublished: () => void }) => {
  const [token, setToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [result, setResult] = useState<{
    published: number
    skipped: number
    errors: { record: string; message: string }[]
    ready: boolean
  } | null>(null)

  const provider = useLoad(
    () =>
      get<{
        id: string
        label: string
        automatic: boolean
        nameservers: string[]
        tokenUrl?: string
        tokenHint?: string
      }>(`/api/domains/${domain.id}/dns/provider`),
    [domain.id],
  )

  if (provider.loading) return null
  if (!provider.data?.automatic) {
    return (
      <Banner>
        <Icon path={icons.domains} size={15} />
        <span>
          {provider.data?.nameservers.length
            ? `This domain resolves through ${provider.data.label}, which Corsair cannot publish to automatically. Add the records below by hand.`
            : "This domain's nameservers do not resolve yet. Add the records below by hand once they do."}
        </span>
      </Banner>
    )
  }

  return (
    <Card title={`One-click setup with ${provider.data.label}`}>
      {result ? (
        <>
          <Banner kind={result.ready ? "good" : result.errors.length ? "warn" : "good"}>
            <Icon path={result.ready ? icons.check : icons.warn} size={15} />
            <span>
              Published {result.published} record(s)
              {result.skipped > 0 && `, ${result.skipped} already correct`}.{" "}
              {result.ready
                ? "This domain is now active."
                : "Give the changes a moment to propagate, then run the check below."}
            </span>
          </Banner>
          {result.errors.length > 0 && (
            <div style={{ marginTop: 12 }}>
              {result.errors.map((e) => (
                <div key={e.record} className="hint">
                  <strong>{e.record}</strong> — {e.message}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              setResult(
                await post(`/api/domains/${domain.id}/dns/publish`, {
                  provider: provider.data!.id,
                  token,
                }),
              )
              setToken("")
              onPublished()
            } catch (e) {
              setError(e)
            } finally {
              setBusy(false)
            }
          }}
        >
          <p className="muted" style={{ marginTop: 0 }}>
            Corsair can write every record below for you. Paste an API token and it will publish
            them directly.
          </p>

          <Field
            label={`${provider.data.label} API token`}
            hint={
              <>
                {provider.data.tokenHint}{" "}
                {provider.data.tokenUrl && (
                  <a href={provider.data.tokenUrl} target="_blank" rel="noreferrer noopener">
                    Create one
                  </a>
                )}
                . The token is used once and never stored.
              </>
            }
          >
            <input
              required
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              autoComplete="off"
            />
          </Field>

          <ErrorText error={error} />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : `Publish records to ${provider.data.label}`}
          </button>
        </form>
      )}
    </Card>
  )
}

// ----------------------------------------------------------- client config --

const ClientConfigTab = () => {
  const { data, loading, error } = useLoad(() =>
    get<{
      servers: { protocol: string; host: string; port: number; security: string }[]
      username_hint: string
      password_hint: string
    }>("/api/client-config"),
  )

  if (loading) return <Loading />
  if (error) return <ErrorText error={error} />

  return (
    <Card title="Client configuration" bodyless>
      <div className="card-body" style={{ paddingBottom: 0 }}>
        <p className="muted" style={{ marginTop: 0 }}>
          Use these settings to set up a mail client. The username is always{" "}
          <strong>{data?.username_hint.toLowerCase()}</strong>, and the password is{" "}
          <strong>{data?.password_hint.toLowerCase()}</strong>.
        </p>
        <p className="muted">
          Most clients find these on their own — enter the address and let it configure itself. Only
          the ports listed here will accept a connection.
        </p>
      </div>
      <table>
        <thead>
          <tr>
            <th>Protocol</th>
            <th>Hostname</th>
            <th>Port</th>
            <th>SSL/TLS</th>
          </tr>
        </thead>
        <tbody>
          {data?.servers.map((server) => (
            <tr key={`${server.protocol}-${server.port}`}>
              <td>{server.protocol}</td>
              <td>
                <Copyable value={server.host} />
              </td>
              <td className="mono">{server.port}</td>
              <td>{server.security}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

// ----------------------------------------------------------- self service --

const SelfServiceTab = ({ domain, onSaved }: { domain: Domain; onSaved: () => void }) => {
  const [enabled, setEnabled] = useState(Boolean(domain.self_service_enabled))
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const gated = error instanceof RequestError && error.needsUpgrade

  return (
    <Card title="Self-service utilities">
      {gated && (
        <div style={{ marginBottom: 14 }}>
          <Banner kind="warn">
            <Icon path={icons.warn} size={15} />
            <span>
              Your current plan does not include self-service features.{" "}
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => navigate("/plans")}
              >
                Upgrade your plan
              </button>
            </span>
          </Banner>
        </div>
      )}

      <p className="muted" style={{ marginTop: 0 }}>
        Address recovery lets users on this domain reset their own mailbox password using the
        recovery web tool, without going through you.
      </p>

      <label className="row" style={{ gap: 8, cursor: "pointer" }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={async (e) => {
            const next = e.target.checked
            setEnabled(next)
            setBusy(true)
            setError(null)
            try {
              await patch(`/api/domains/${domain.id}`, { self_service_enabled: next })
              onSaved()
            } catch (err) {
              setEnabled(!next)
              setError(err)
            } finally {
              setBusy(false)
            }
          }}
        />
        <span>Enable address recovery</span>
        {busy && <Spinner />}
      </label>

      {!gated && <ErrorText error={error} />}
    </Card>
  )
}

// -------------------------------------------------------- address detail --

export const AddressDetailPage = ({ id }: { id: string }) => {
  const [tab, setTab] = useState<"general" | "password">("general")
  const { data, error, loading, reload } = useLoad(() => get<Address>(`/api/addresses/${id}`), [id])
  const activity = useLoad(
    () =>
      get<{ days: { day: string; sent: number; received: number }[] }>(
        `/api/addresses/${id}/activity`,
      ),
    [id],
  )

  if (loading) return <Loading />
  if (error) return <ErrorText error={error} />
  if (!data) return null

  return (
    <div className="page">
      <div className="row">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate("/domains")}>
          <Icon path={icons.back} size={15} />
        </button>
        <h2 style={{ margin: 0, fontWeight: 650, letterSpacing: "-0.02em" }}>{data.email}</h2>
        <Pill>{TYPE_LABEL[data.type] ?? data.type}</Pill>
      </div>

      <div className="tabs">
        <button
          type="button"
          className={`tab${tab === "general" ? " active" : ""}`}
          onClick={() => setTab("general")}
        >
          General
        </button>
        {(data.type === "standard" || data.type === "catchall") && (
          <button
            type="button"
            className={`tab${tab === "password" ? " active" : ""}`}
            onClick={() => setTab("password")}
          >
            Change password
          </button>
        )}
      </div>

      {tab === "general" && (
        <>
          <Card title="Recent activity">
            <Sparkline days={activity.data?.days ?? []} />
          </Card>
          <AddressGeneral address={data} onSaved={reload} />
        </>
      )}
      {tab === "password" && <ChangeAddressPassword address={data} />}
    </div>
  )
}

const AddressGeneral = ({ address, onSaved }: { address: Address; onSaved: () => void }) => {
  const [name, setName] = useState(address.name ?? "")
  const [filterId, setFilterId] = useState(address.filter_id ?? "")
  const [destinations, setDestinations] = useState(address.destinations.join("\n"))
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const filters = useLoad(() =>
    get<Page<{ id: string; name: string }>>("/api/filters?per_page=100"),
  )
  const forwarding = address.type === "alias" || address.type === "group"

  return (
    <>
      <Card title="General">
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              await patch(`/api/addresses/${address.id}`, {
                name: name || null,
                filter_id: filterId || null,
                ...(forwarding
                  ? {
                      destinations: destinations
                        .split(/[,\n]/)
                        .map((d) => d.trim())
                        .filter(Boolean),
                    }
                  : {}),
              })
              onSaved()
            } catch (e) {
              setError(e)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field label="Name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          {forwarding && (
            <Field label={address.type === "alias" ? "Destination" : "Recipients"}>
              <textarea
                style={{ minHeight: 90 }}
                value={destinations}
                onChange={(e) => setDestinations(e.target.value)}
              />
            </Field>
          )}

          {!forwarding && (
            <Field label="Active filter" hint="A sieve script applied to incoming mail.">
              <select value={filterId} onChange={(e) => setFilterId(e.target.value)}>
                <option value="">no filter</option>
                {filters.data?.data.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Field>
          )}

          <ErrorText error={error} />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : "Update address"}
          </button>
        </form>
      </Card>

      {!forwarding && <RecoveryAddress address={address} onSaved={onSaved} />}

      <Card title="Danger zone">
        <div className="row spread">
          <span className="muted">
            Deleting this address permanently removes its mailbox and every message in it.
          </span>
          <button type="button" className="btn btn-danger" onClick={() => setDeleting(true)}>
            <Icon path={icons.trash} size={15} /> Delete address
          </button>
        </div>
      </Card>

      {deleting && (
        <Dialog title={`Delete ${address.email}?`} onClose={() => setDeleting(false)}>
          <p>
            This removes the mailbox and everything in it. Mail sent to this address afterwards will
            bounce.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                await del(`/api/addresses/${address.id}`)
                navigate("/domains")
              }}
            >
              Delete permanently
            </button>
            <button type="button" className="btn" onClick={() => setDeleting(false)}>
              Cancel
            </button>
          </div>
        </Dialog>
      )}
    </>
  )
}

/**
 * Where a self-service recovery link is sent for this mailbox.
 *
 * Deliberately a different mailbox: a reset link delivered to the mailbox whose
 * password was lost helps nobody.
 */
const RecoveryAddress = ({ address, onSaved }: { address: Address; onSaved: () => void }) => {
  const [value, setValue] = useState(address.recovery_address ?? "")
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Card title="Recovery address">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          setSaved(false)
          try {
            await post(`/api/addresses/${address.id}/recovery`, {
              recovery_address: value || null,
            })
            setSaved(true)
            onSaved()
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="Send recovery links to"
          hint="Only used when self-service recovery is enabled on this domain. Leave empty to disable it for this mailbox."
        >
          <input
            type="email"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="somewhere-else@example.com"
          />
        </Field>
        {saved && (
          <div style={{ marginBottom: 14 }}>
            <Banner kind="good">
              <Icon path={icons.check} size={15} />
              <span>Saved.</span>
            </Banner>
          </div>
        )}
        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner /> : "Save recovery address"}
        </button>
      </form>
    </Card>
  )
}

const ChangeAddressPassword = ({ address }: { address: Address }) => {
  // A mailbox that is the account holder's own signs in with the account
  // password. Offering a second field here would let someone set a password
  // that never works, with nothing to say why.
  if (address.uses_account_password) {
    return <LinkedAddressPassword address={address} />
  }

  return <ChangeOwnAddressPassword address={address} />
}

/**
 * A mailbox that signs in with the account password. The only action offered is
 * the way back out — giving it a password of its own, for when it is handed to
 * someone who must not have the panel.
 */
const LinkedAddressPassword = ({ address }: { address: Address }) => {
  const [separating, setSeparating] = useState(false)
  const [password, setPassword] = useState("")
  const [show, setShow] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Card title="Password">
      <p className="muted" style={{ marginTop: 0 }}>
        This mailbox signs in with <strong>your account password</strong> — the same one you used
        for this panel. Change it under Account and it changes here too.
      </p>

      {!separating && (
        <button type="button" className="btn btn-sm" onClick={() => setSeparating(true)}>
          Give this mailbox its own password
        </button>
      )}

      {separating && (
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              await post(`/api/addresses/${address.id}/link`, {
                use_account_password: false,
                password,
              })
              window.location.reload()
            } catch (e) {
              setError(e)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field
            label="Mailbox password"
            hint="Use this when someone else reads this mailbox. It opens mail and never this panel."
          >
            <div className="row" style={{ flexWrap: "nowrap" }}>
              <input
                required
                minLength={8}
                type={show ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button type="button" className="btn btn-sm" onClick={() => setShow(!show)}>
                <Icon path={icons.eye} size={14} />
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  setPassword(generatePassword())
                  setShow(true)
                }}
              >
                Generate
              </button>
            </div>
          </Field>
          <ErrorText error={error} />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-primary btn-sm" disabled={busy} type="submit">
              {busy ? <Spinner /> : "Separate this mailbox"}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setSeparating(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </Card>
  )
}

const ChangeOwnAddressPassword = ({ address }: { address: Address }) => {
  const [password, setPassword] = useState("")
  const [show, setShow] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Card title="Change password">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          setDone(false)
          try {
            await post(`/api/addresses/${address.id}/password`, { password })
            setDone(true)
            setPassword("")
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="New password"
          hint="Every mail client signed in as this address will need updating."
        >
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <input
              required
              minLength={8}
              type={show ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <button type="button" className="btn btn-sm" onClick={() => setShow(!show)}>
              <Icon path={icons.eye} size={14} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setPassword(generatePassword())
                setShow(true)
              }}
            >
              Generate
            </button>
          </div>
        </Field>

        {done && (
          <div style={{ marginBottom: 14 }}>
            <Banner kind="good">
              <Icon path={icons.check} size={15} />
              <span>Password changed.</span>
            </Banner>
          </div>
        )}
        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner /> : "Change password"}
        </button>
      </form>
    </Card>
  )
}
