import { useState } from "react"
import { navigate } from "../app.tsx"
import {
  Banner,
  Card,
  DataTable,
  Dialog,
  ErrorText,
  Field,
  Icon,
  icons,
  Spinner,
  statusPill,
  useLoad,
} from "../components/index.tsx"
import { del, formatBytes, get, type Page, post, qs, RequestError } from "../lib/api.ts"

type Transfer = {
  id: string
  server: string
  username: string
  destination: string | null
  status: string
  messages_done: number
  messages_total: number
  folders_done: number
  folders_total: number
  bytes_done: number
  last_error: string | null
}

export const TransfersPage = () => {
  const [query, setQuery] = useState({
    search: "",
    sort: "created_at" as string | null,
    direction: "desc" as "asc" | "desc",
    page: 1,
    perPage: 10,
  })
  const [creating, setCreating] = useState(false)

  const { data, error, loading, reload } = useLoad(
    () =>
      get<Page<Transfer>>(
        `/api/transfers${qs({
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
      <DataTable<Transfer>
        columns={[
          {
            key: "username",
            label: "Username",
            sortable: true,
            render: (t) => <strong>{t.username}</strong>,
          },
          {
            key: "server",
            label: "Server",
            sortable: true,
            render: (t) => <span className="mono">{t.server}</span>,
          },
          {
            key: "destination",
            label: "Destination",
            render: (t) => <span className="muted">{t.destination ?? "—"}</span>,
          },
          {
            key: "status",
            label: "Status",
            sortable: true,
            render: (t) => (
              <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
                {t.status === "running" && (
                  <span className="muted">
                    {t.messages_done} msg · {formatBytes(t.bytes_done)}
                  </span>
                )}
                {t.status === "done" && <span className="muted">{t.messages_done} messages</span>}
                {statusPill(t.status)}
              </div>
            ),
          },
        ]}
        page={data}
        loading={loading}
        query={query}
        onQuery={(next) => setQuery((q) => ({ ...q, ...next }))}
        emptyText="Looks like there are no transfers yet."
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon path={icons.plus} size={15} /> New transfer
          </button>
        }
      />

      {data?.data.some((t) => t.last_error) && (
        <Card title="Recent failures">
          {data.data
            .filter((t) => t.last_error)
            .map((t) => (
              <div key={t.id} className="field">
                <div className="label-text">
                  {t.username} at {t.server}
                </div>
                <div className="faint">{t.last_error}</div>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  onClick={async () => {
                    await del(`/api/transfers/${t.id}`)
                    reload()
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
        </Card>
      )}

      {creating && (
        <AddTransfer
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            reload()
          }}
        />
      )}
    </div>
  )
}

const AddTransfer = ({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) => {
  const [server, setServer] = useState("")
  const [port, setPort] = useState(993)
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [destination, setDestination] = useState("")
  const [messageLimit, setMessageLimit] = useState("")
  const [sizeLimit, setSizeLimit] = useState("")
  const [newerThan, setNewerThan] = useState("")
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const destinations = useLoad(() =>
    get<{ data: { id: string; email: string }[] }>("/api/transfers/destinations"),
  )
  const gated = error instanceof RequestError && error.needsUpgrade

  return (
    <Dialog title="Add a new transfer" onClose={onClose}>
      {gated && (
        <div style={{ marginBottom: 14 }}>
          <Banner kind="warn">
            <Icon path={icons.warn} size={15} />
            <span>
              Your current plan does not include mailbox transfers.{" "}
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

      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await post("/api/transfers", {
              server,
              port,
              secure: true,
              username,
              password,
              destination_address_id: destination,
              message_limit: messageLimit ? Number(messageLimit) : null,
              size_limit: sizeLimit ? Number(sizeLimit) * 1024 * 1024 : null,
              newer_than: newerThan ? new Date(newerThan).toISOString() : null,
              accepted_policy: accepted,
            })
            onCreated()
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="Server"
          hint="The IMAP server that holds the old mail. Check your previous provider for its hostname."
        >
          <input
            required
            value={server}
            onChange={(e) => setServer(e.target.value)}
            placeholder="imap.previous-host.com"
          />
        </Field>

        <Field label="Port">
          <input
            type="number"
            value={port}
            onChange={(e) => setPort(Number(e.target.value))}
            min={1}
            max={65535}
          />
        </Field>

        <Field label="Username">
          <input required value={username} onChange={(e) => setUsername(e.target.value)} />
        </Field>

        <Field
          label="Password"
          hint="Stored encrypted and erased as soon as the transfer finishes."
        >
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <Field label="Destination address" hint="An existing mailbox to copy the mail into.">
          <select required value={destination} onChange={(e) => setDestination(e.target.value)}>
            <option value="">Choose a mailbox</option>
            {destinations.data?.data.map((d) => (
              <option key={d.id} value={d.id}>
                {d.email}
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-3">
          <Field label="Message limit">
            <input
              type="number"
              value={messageLimit}
              onChange={(e) => setMessageLimit(e.target.value)}
              placeholder="all"
            />
          </Field>
          <Field label="Size limit (MB)">
            <input
              type="number"
              value={sizeLimit}
              onChange={(e) => setSizeLimit(e.target.value)}
              placeholder="none"
            />
          </Field>
          <Field label="Newer than">
            <input type="date" value={newerThan} onChange={(e) => setNewerThan(e.target.value)} />
          </Field>
        </div>

        <label className="row" style={{ gap: 8, cursor: "pointer", marginBottom: 14 }}>
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
          />
          <span className="muted">
            I have the right to access this mailbox and agree to the transfer policy.
          </span>
        </label>

        {!gated && <ErrorText error={error} />}
        <button type="submit" className="btn btn-primary" disabled={busy || !accepted}>
          {busy ? <Spinner /> : "Add to queue"}
        </button>
      </form>
    </Dialog>
  )
}
