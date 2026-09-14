import { useState } from "react"
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
  Pill,
  Spinner,
  useLoad,
} from "../components/index.tsx"
import { del, formatDate, get, type Page, post, qs } from "../lib/api.ts"

type ApiKey = {
  id: string
  name: string
  permission: "full_access" | "sending_access"
  domain_id: string | null
  domain: string | null
  token_prefix: string
  last_used_at: string | null
  created_at: string
}

type Sent = {
  id: string
  to: string[]
  from: string
  subject: string
  last_event: string
  scheduled_at: string | null
  created_at: string
}

type Suppression = {
  id: string
  email: string
  reason: string
  detail: string | null
  created_at: string
}

type Domain = { id: string; name: string; status: string }

const eventPill = (event: string) => {
  const kind =
    event === "delivered"
      ? "good"
      : ["bounced", "complained", "failed", "suppressed"].includes(event)
        ? "bad"
        : event === "canceled"
          ? "neutral"
          : "warn"
  return <Pill kind={kind}>{event.replace(/_/g, " ")}</Pill>
}

export const SendingPage = () => {
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState({
    search: "",
    sort: "created" as string | null,
    direction: "desc" as "asc" | "desc",
    page: 1,
    perPage: 10,
  })

  const keys = useLoad(() => get<{ data: ApiKey[] }>("/api/api-keys"))
  const sent = useLoad(() => get<{ data: Sent[] }>("/api/emails?limit=25"))
  const suppressions = useLoad(
    () =>
      get<Page<Suppression>>(
        `/api/suppressions${qs({
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
      <Banner>
        <Icon path={icons.send} size={15} />
        <span>
          Applications send as your domains over HTTP with a key from here. The API is Resend's:
          point a Resend SDK at <span className="mono">{window.location.origin}/api</span> and it
          works unchanged. Delivery events arrive through your webhooks as{" "}
          <span className="mono">email.*</span>.
        </span>
      </Banner>

      <ErrorText error={keys.error} />

      <Card
        title="API keys"
        actions={
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => setCreating(true)}
          >
            <Icon path={icons.plus} size={15} /> New key
          </button>
        }
        bodyless
      >
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Access</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!keys.data?.data.length && (
              <tr>
                <td colSpan={4} className="empty">
                  No keys yet. Create one for each application that sends.
                </td>
              </tr>
            )}
            {keys.data?.data.map((key) => (
              <tr key={key.id}>
                <td>
                  <strong>{key.name}</strong>
                  <div className="faint mono">{key.token_prefix}…</div>
                </td>
                <td className="muted">
                  {key.permission === "full_access"
                    ? "Full access"
                    : `Sending only${key.domain ? `, from ${key.domain}` : ""}`}
                </td>
                <td className="muted">
                  {key.last_used_at ? formatDate(key.last_used_at) : "never"}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      await del(`/api/api-keys/${key.id}`)
                      keys.reload()
                    }}
                  >
                    <Icon path={icons.trash} size={14} /> Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Recent sends"
        actions={
          <button type="button" className="btn btn-sm btn-ghost" onClick={sent.reload}>
            <Icon path={icons.refresh} size={15} />
          </button>
        }
        bodyless
      >
        <table>
          <thead>
            <tr>
              <th>To</th>
              <th>Subject</th>
              <th>Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {sent.loading && (
              <tr>
                <td colSpan={4} className="empty">
                  <Spinner />
                </td>
              </tr>
            )}
            {!sent.loading && !sent.data?.data.length && (
              <tr>
                <td colSpan={4} className="empty">
                  Nothing sent over the API yet.
                </td>
              </tr>
            )}
            {sent.data?.data.map((email) => (
              <tr key={email.id}>
                <td>
                  <span className="truncate">{email.to.join(", ")}</span>
                  <div className="faint">{email.from}</div>
                </td>
                <td className="truncate">{email.subject}</td>
                <td>{eventPill(email.last_event)}</td>
                <td className="muted">
                  {formatDate(
                    email.last_event === "scheduled" ? email.scheduled_at : email.created_at,
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <h2 style={{ margin: "8px 0 0", fontSize: 15, fontWeight: 650 }}>Suppressions</h2>
      <p className="muted" style={{ margin: 0 }}>
        Addresses the sending API will not mail again: ones that do not exist, and people who
        reported a message as spam. Remove one to let mail through to it again. Mailboxes on this
        server are never affected.
      </p>

      <DataTable<Suppression>
        columns={[
          {
            key: "email",
            label: "Address",
            sortable: true,
            render: (s) => (
              <>
                <strong className="mono">{s.email}</strong>
                {s.detail && <div className="faint truncate">{s.detail}</div>}
              </>
            ),
          },
          {
            key: "reason",
            label: "Reason",
            sortable: true,
            render: (s) => <Pill kind={s.reason === "manual" ? "neutral" : "bad"}>{s.reason}</Pill>,
          },
          {
            key: "created",
            label: "Since",
            sortable: true,
            render: (s) => <span className="muted">{formatDate(s.created_at)}</span>,
          },
          {
            key: "remove",
            label: "",
            render: (s) => (
              <button
                type="button"
                className="btn btn-sm"
                onClick={async () => {
                  await del(`/api/suppressions/${s.id}`)
                  suppressions.reload()
                }}
              >
                Remove
              </button>
            ),
          },
        ]}
        page={suppressions.data}
        loading={suppressions.loading}
        query={query}
        onQuery={(next) => setQuery((q) => ({ ...q, ...next }))}
        emptyText="No suppressed addresses."
      />

      {creating && (
        <CreateKey
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            keys.reload()
          }}
        />
      )}
    </div>
  )
}

const CreateKey = ({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) => {
  const [name, setName] = useState("")
  const [permission, setPermission] = useState<ApiKey["permission"]>("sending_access")
  const [domainId, setDomainId] = useState("")
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const domains = useLoad(() => get<Page<Domain>>("/api/domains?per_page=100"))

  if (token) {
    return (
      <Dialog title="Save your API key" onClose={onCreated}>
        <Banner kind="warn">
          <Icon path={icons.warn} size={15} />
          <span>
            Shown once. Put it wherever the application reads its secrets. A lost key is revoked and
            replaced, never recovered.
          </span>
        </Banner>
        <div style={{ margin: "16px 0" }}>
          <Copyable value={token} />
        </div>
        <button type="button" className="btn btn-primary" onClick={onCreated}>
          I have saved it
        </button>
      </Dialog>
    )
  }

  return (
    <Dialog title="New API key" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            const created = await post<{ token: string }>("/api/api-keys", {
              name,
              permission,
              domain_id: permission === "sending_access" && domainId ? domainId : null,
            })
            setToken(created.token)
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="Name"
          hint="Which application holds it, so you know what breaks if you revoke it."
        >
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="website"
          />
        </Field>

        <Field
          label="Access"
          hint="Sending only is right for almost every application. Full access can also read and cancel sends."
        >
          <select
            value={permission}
            onChange={(e) => setPermission(e.target.value as ApiKey["permission"])}
          >
            <option value="sending_access">Sending only</option>
            <option value="full_access">Full access</option>
          </select>
        </Field>

        {permission === "sending_access" && (
          <Field
            label="Domain"
            hint="Limit the key to one domain, or let it send from any of yours."
          >
            <select value={domainId} onChange={(e) => setDomainId(e.target.value)}>
              <option value="">Any domain on this account</option>
              {domains.data?.data
                .filter((d) => d.status === "active")
                .map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
            </select>
          </Field>
        )}

        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
          {busy ? <Spinner /> : "Create key"}
        </button>
      </form>
    </Dialog>
  )
}
