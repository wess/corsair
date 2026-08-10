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
  Spinner,
  statusPill,
  useLoad,
} from "../components/index.tsx"
import { del, formatDate, get, type Page, patch, post, qs } from "../lib/api.ts"

type Hook = {
  id: string
  url: string
  description: string | null
  events: string[]
  domain_id: string | null
  status: string
  disabled_reason: string | null
  consecutive_failures: number
  last_success_at: string | null
  signing_secret: string
  created_at: string
}

type HookEvent = {
  id: string
  type: string
  status: string
  attempts: number
  delivered_at: string | null
  created_at: string
  payload: unknown
}

type Attempt = {
  id: string
  http_status_code: number | null
  response: string | null
  error: string | null
  duration_ms: number | null
  sent_at: string
}

// ------------------------------------------------------------------- list --

export const HooksPage = () => {
  const [query, setQuery] = useState({
    search: "",
    sort: "created" as string | null,
    direction: "desc" as "asc" | "desc",
    page: 1,
    perPage: 10,
  })
  const [creating, setCreating] = useState(false)

  const { data, error, loading, reload } = useLoad(
    () =>
      get<Page<Hook>>(
        `/api/webhooks${qs({
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

      <Banner>
        <Icon path={icons.webhook} size={15} />
        <span>
          Corsair POSTs a signed JSON payload to your endpoint when something happens. Every
          delivery carries a <span className="mono">webhook-signature</span> header — verify it, or
          anyone who learns your URL can forge events.
        </span>
      </Banner>

      <DataTable<Hook>
        columns={[
          {
            key: "url",
            label: "Endpoint",
            sortable: true,
            render: (h) => (
              <>
                <strong className="truncate">{h.url}</strong>
                {h.description && <div className="faint">{h.description}</div>}
              </>
            ),
          },
          {
            key: "events",
            label: "Events",
            render: (h) => (
              <span className="muted mono">
                {h.events.length ? h.events.join(", ") : "everything"}
              </span>
            ),
          },
          {
            key: "status",
            label: "Status",
            sortable: true,
            render: (h) => (
              <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                {h.consecutive_failures > 0 && (
                  <Pill kind="warn">{h.consecutive_failures} failing</Pill>
                )}
                {statusPill(h.status)}
              </div>
            ),
          },
        ]}
        page={data}
        loading={loading}
        query={query}
        onQuery={(next) => setQuery((q) => ({ ...q, ...next }))}
        emptyText="No endpoints yet. Add one to be told when mail arrives."
        onRowClick={(h) => navigate(`/webhooks/${h.id}`)}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Icon path={icons.plus} size={15} /> New endpoint
          </button>
        }
      />

      {creating && (
        <CreateHook
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

const CreateHook = ({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) => {
  const [url, setUrl] = useState("")
  const [description, setDescription] = useState("")
  const [selected, setSelected] = useState<string[]>(["*"])
  const [secret, setSecret] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const catalogue = useLoad(() =>
    get<{ data: { type: string; family: string }[] }>("/api/webhooks/events"),
  )

  const families = [...new Set((catalogue.data?.data ?? []).map((e) => e.family))].map(
    (family) => `${family}.*`,
  )

  const toggle = (pattern: string) =>
    setSelected((current) =>
      current.includes(pattern)
        ? current.filter((p) => p !== pattern)
        : [...current.filter((p) => p !== "*"), pattern],
    )

  if (secret) {
    return (
      <Dialog title="Save your signing secret" onClose={onCreated}>
        <Banner kind="warn">
          <Icon path={icons.warn} size={15} />
          <span>
            This is shown once. It is what proves a delivery came from this server — store it
            wherever your endpoint reads its configuration.
          </span>
        </Banner>
        <div style={{ margin: "16px 0" }}>
          <Copyable value={secret} />
        </div>
        <button type="button" className="btn btn-primary" onClick={onCreated}>
          I have saved it
        </button>
      </Dialog>
    )
  }

  return (
    <Dialog title="New endpoint" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            const created = await post<Hook>("/api/webhooks", {
              url,
              events: selected,
              description: description || null,
            })
            setSecret(created.signing_secret)
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="Endpoint URL"
          hint="Has to be reachable from the public internet. Private and loopback addresses are refused."
        >
          <input
            required
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://example.com/corsair/hook"
          />
        </Field>

        <Field label="Description">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="what this endpoint is for"
          />
        </Field>

        <Field label="Events" hint="Pick families, or leave everything selected.">
          <div className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className={`btn btn-sm${selected.includes("*") ? " btn-primary" : ""}`}
              onClick={() => setSelected(["*"])}
            >
              Everything
            </button>
            {families.map((family) => (
              <button
                key={family}
                type="button"
                className={`btn btn-sm${selected.includes(family) ? " btn-primary" : ""}`}
                onClick={() => toggle(family)}
              >
                {family}
              </button>
            ))}
          </div>
        </Field>

        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy || !selected.length}>
          {busy ? <Spinner /> : "Create endpoint"}
        </button>
      </form>
    </Dialog>
  )
}

// ----------------------------------------------------------------- detail --

export const HookDetailPage = ({ id }: { id: string }) => {
  const [tested, setTested] = useState<{
    ok: boolean
    status: number | null
    error?: string
    response?: string
    duration_ms: number
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [rotated, setRotated] = useState<string | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null)

  const { data, error, loading, reload } = useLoad(() => get<Hook>(`/api/webhooks/${id}`), [id])
  const events = useLoad(
    () => get<Page<HookEvent>>(`/api/webhooks/${id}/events?per_page=25`),
    [id, tested],
  )

  if (loading) return <Loading />
  if (error) return <ErrorText error={error} />
  if (!data) return null

  return (
    <div className="page">
      <div className="row">
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => navigate("/webhooks")}
        >
          <Icon path={icons.back} size={15} />
        </button>
        <h2 style={{ margin: 0, fontWeight: 650, letterSpacing: "-0.02em" }} className="truncate">
          {data.url}
        </h2>
        {statusPill(data.status)}
      </div>

      {data.disabled_reason && (
        <Banner kind="bad">
          <Icon path={icons.warn} size={15} />
          <span>
            {data.disabled_reason}{" "}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={async () => {
                await patch(`/api/webhooks/${id}`, { status: "enabled" })
                reload()
              }}
            >
              Re-enable
            </button>
          </span>
        </Banner>
      )}

      <Card
        title="Endpoint"
        actions={
          <div className="row">
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true)
                setTested(null)
                try {
                  setTested(await post(`/api/webhooks/${id}/test`))
                } finally {
                  setBusy(false)
                }
              }}
            >
              {busy ? <Spinner /> : "Send test"}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => {
                const result = await post<Hook>(`/api/webhooks/${id}/rotate`)
                setRotated(result.signing_secret)
                reload()
              }}
            >
              Rotate secret
            </button>
          </div>
        }
      >
        {tested && (
          <div style={{ marginBottom: 14 }}>
            <Banner kind={tested.ok ? "good" : "bad"}>
              <Icon path={tested.ok ? icons.check : icons.warn} size={15} />
              <span>
                {tested.ok
                  ? `Endpoint answered ${tested.status} in ${tested.duration_ms}ms.`
                  : `Failed after ${tested.duration_ms}ms — ${tested.error ?? `HTTP ${tested.status}`}.`}
              </span>
            </Banner>
          </div>
        )}

        <div className="row spread" style={{ padding: "6px 0" }}>
          <span className="muted">Events</span>
          <span className="mono">{data.events.length ? data.events.join(", ") : "everything"}</span>
        </div>
        <div className="row spread" style={{ padding: "6px 0" }}>
          <span className="muted">Signing secret</span>
          <span className="mono faint">{data.signing_secret}</span>
        </div>
        <div className="row spread" style={{ padding: "6px 0" }}>
          <span className="muted">Last success</span>
          <span>{data.last_success_at ? formatDate(data.last_success_at) : "never"}</span>
        </div>

        <div className="row" style={{ marginTop: 16 }}>
          <button
            type="button"
            className="btn btn-danger"
            onClick={async () => {
              await del(`/api/webhooks/${id}`)
              navigate("/webhooks")
            }}
          >
            <Icon path={icons.trash} size={15} /> Delete endpoint
          </button>
        </div>
      </Card>

      <Card title="Recent deliveries" bodyless>
        <table>
          <thead>
            <tr>
              <th>Event</th>
              <th>Status</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {!events.data?.data.length && (
              <tr>
                <td colSpan={3} className="empty">
                  Nothing delivered yet.
                </td>
              </tr>
            )}
            {events.data?.data.map((event) => (
              <tr
                key={event.id}
                onClick={() => setSelectedEvent(event.id)}
                style={{ cursor: "pointer" }}
              >
                <td>
                  <strong className="mono">{event.type}</strong>
                  <div className="faint mono">{event.id}</div>
                </td>
                <td>
                  <div className="row" style={{ justifyContent: "flex-end", gap: 6 }}>
                    {event.attempts > 1 && <Pill kind="warn">{event.attempts} attempts</Pill>}
                    {statusPill(event.status)}
                  </div>
                </td>
                <td className="muted">{formatDate(event.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {rotated && (
        <Dialog title="New signing secret" onClose={() => setRotated(null)}>
          <Banner kind="warn">
            <Icon path={icons.warn} size={15} />
            <span>
              Shown once. Deliveries are signed with this from now on — update your endpoint before
              the next event fires.
            </span>
          </Banner>
          <div style={{ margin: "16px 0" }}>
            <Copyable value={rotated} />
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setRotated(null)}>
            Done
          </button>
        </Dialog>
      )}

      {selectedEvent && (
        <EventDetail
          hookId={id}
          eventId={selectedEvent}
          onClose={() => setSelectedEvent(null)}
          onReplayed={() => events.reload()}
        />
      )}
    </div>
  )
}

const EventDetail = ({
  hookId,
  eventId,
  onClose,
  onReplayed,
}: {
  hookId: string
  eventId: string
  onClose: () => void
  onReplayed: () => void
}) => {
  const { data, loading } = useLoad(
    () => get<HookEvent & { attempts: Attempt[] }>(`/api/webhooks/${hookId}/events/${eventId}`),
    [hookId, eventId],
  )

  return (
    <Dialog title="Delivery" onClose={onClose}>
      {loading && <Spinner />}
      {data && (
        <>
          <div className="row spread" style={{ padding: "6px 0" }}>
            <span className="muted">Type</span>
            <span className="mono">{data.type}</span>
          </div>
          <div className="row spread" style={{ padding: "6px 0" }}>
            <span className="muted">Status</span>
            {statusPill(data.status)}
          </div>

          <div className="field" style={{ marginTop: 14 }}>
            <div className="label-text">Payload</div>
            <pre
              className="mono"
              style={{
                background: "var(--surface-2)",
                padding: 12,
                borderRadius: 8,
                overflowX: "auto",
                fontSize: 12,
              }}
            >
              {JSON.stringify(data.payload, null, 2)}
            </pre>
          </div>

          <div className="field">
            <div className="label-text">Attempts</div>
            {data.attempts.map((attempt) => (
              <div key={attempt.id} className="row spread" style={{ padding: "5px 0" }}>
                <span className="muted">{formatDate(attempt.sent_at)}</span>
                <span>
                  {attempt.error ? (
                    <span style={{ color: "var(--bad)" }}>{attempt.error}</span>
                  ) : (
                    <>
                      <span className="mono">HTTP {attempt.http_status_code}</span>{" "}
                      <span className="faint">{attempt.duration_ms}ms</span>
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              await post(`/api/webhooks/${hookId}/events/${eventId}/replay`)
              onReplayed()
              onClose()
            }}
          >
            <Icon path={icons.refresh} size={15} /> Replay
          </button>
        </>
      )}
    </Dialog>
  )
}
