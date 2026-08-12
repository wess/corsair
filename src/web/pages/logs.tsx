import { useEffect, useRef, useState } from "react"
import {
  Banner,
  Card,
  ErrorText,
  Icon,
  icons,
  Loading,
  Spinner,
  useLoad,
} from "../components/index.tsx"
import { get } from "../lib/api.ts"

/**
 * The server's own journal, for the person who runs it.
 *
 * Exists so an operator can answer "what did it actually say" without an SSH
 * session — which is when a mail problem gets diagnosed, and when it does not.
 * Owner-only, and the nav entry is absent for everyone else.
 */

type Entry = { at: string; unit: string; priority: number; message: string }
type Source = { key: string; label: string; unit: string }

// syslog severities. Anything at error or worse is worth colouring; the rest is
// noise until you are looking for it.
const SEVERITY: Record<number, { label: string; tone: string }> = {
  0: { label: "emerg", tone: "bad" },
  1: { label: "alert", tone: "bad" },
  2: { label: "crit", tone: "bad" },
  3: { label: "err", tone: "bad" },
  4: { label: "warn", tone: "warn" },
  5: { label: "notice", tone: "" },
  6: { label: "info", tone: "" },
  7: { label: "debug", tone: "muted" },
}

const WINDOWS: { key: string; label: string }[] = [
  { key: "15m", label: "15 min" },
  { key: "1h", label: "1 hour" },
  { key: "6h", label: "6 hours" },
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "all", label: "Everything" },
]

const time = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour12: false })
}

const day = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString()
}

export const LogsPage = () => {
  const [unit, setUnit] = useState("corsair")
  const [since, setSince] = useState("1h")
  const [priority, setPriority] = useState("")
  const [search, setSearch] = useState("")
  const [applied, setApplied] = useState("")
  const [lines, setLines] = useState(300)
  const [follow, setFollow] = useState(false)
  const [entries, setEntries] = useState<Entry[]>([])
  const [meta, setMeta] = useState<{ available: boolean; truncated: boolean; reason?: string }>({
    available: true,
    truncated: false,
  })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const bottom = useRef<HTMLDivElement | null>(null)

  const sources = useLoad(() => get<{ data: Source[] }>("/api/logs/sources"))

  const load = async () => {
    setBusy(true)
    setError(null)
    try {
      const params = new URLSearchParams({ unit, since, lines: String(lines) })
      if (priority) params.set("priority", priority)
      if (applied) params.set("q", applied)
      const result = await get<{
        data: Entry[]
        available: boolean
        truncated: boolean
        reason?: string
      }>(`/api/logs?${params.toString()}`)
      setEntries(result.data)
      setMeta({ available: result.available, truncated: result.truncated, reason: result.reason })
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: load closes over exactly these
  useEffect(() => {
    void load()
  }, [unit, since, priority, applied, lines])

  useEffect(() => {
    if (!follow) return
    const id = setInterval(() => void load(), 5000)
    return () => clearInterval(id)
  })

  useEffect(() => {
    if (follow) bottom.current?.scrollIntoView({ behavior: "smooth" })
  }, [follow])

  /** Saves what is on screen, which is what someone pasting into an issue wants. */
  const download = () => {
    const text = entries
      .map((e) => `${e.at} ${SEVERITY[e.priority]?.label ?? e.priority} ${e.message}`)
      .join("\n")
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `${unit}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (sources.loading) return <Loading />

  let lastDay = ""

  return (
    <div className="page">
      <div className="row spread">
        <h2 style={{ margin: 0, fontWeight: 650, letterSpacing: "-0.02em" }}>Server logs</h2>
        <div className="row" style={{ gap: 8 }}>
          <button
            type="button"
            className={`btn btn-sm${follow ? " btn-primary" : ""}`}
            onClick={() => setFollow(!follow)}
            title="Reload every five seconds"
          >
            <Icon path={icons.refresh} size={14} /> {follow ? "Following" : "Follow"}
          </button>
          <button
            type="button"
            className="btn btn-sm"
            onClick={download}
            disabled={!entries.length}
          >
            <Icon path={icons.download} size={14} /> Save
          </button>
        </div>
      </div>

      <p className="hint" style={{ marginTop: 4 }}>
        What this machine is saying about itself. Credentials are stripped before the lines leave
        the server.
      </p>

      <Card bodyless>
        <div className="log-controls">
          <select value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Log source">
            {sources.data?.data.map((s: Source) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>

          <select value={since} onChange={(e) => setSince(e.target.value)} aria-label="Time range">
            {WINDOWS.map((w) => (
              <option key={w.key} value={w.key}>
                {w.label}
              </option>
            ))}
          </select>

          <select
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
            aria-label="Severity"
          >
            <option value="">All severities</option>
            <option value="3">Errors only</option>
            <option value="4">Warnings and worse</option>
          </select>

          <select
            value={String(lines)}
            onChange={(e) => setLines(Number(e.target.value))}
            aria-label="Lines"
          >
            {[100, 300, 1000, 2000].map((n) => (
              <option key={n} value={n}>
                {n} lines
              </option>
            ))}
          </select>

          <form
            style={{ display: "contents" }}
            onSubmit={(e) => {
              e.preventDefault()
              setApplied(search.trim())
            }}
          >
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search these logs"
              aria-label="Search"
            />
          </form>
          {busy && <Spinner />}
        </div>
      </Card>

      <ErrorText error={error} />

      {!meta.available && (
        <Banner kind="warn">
          <Icon path={icons.warn} size={15} />
          <span>{meta.reason ?? "The journal cannot be read on this server."}</span>
        </Banner>
      )}

      {meta.available && !entries.length && !busy && (
        <p className="muted" style={{ textAlign: "center", padding: "28px 0" }}>
          Nothing in this window.{" "}
          {applied ? "Try a wider range, or a different search." : "Try a wider range."}
        </p>
      )}

      {entries.length > 0 && (
        <>
          {meta.truncated && (
            <p className="hint">
              Showing the most recent {lines} lines — there are older ones than this.
            </p>
          )}
          <div className="log-view">
            {entries.map((e, i) => {
              const d = day(e.at)
              const newDay = d !== lastDay
              lastDay = d
              const sev = SEVERITY[e.priority] ?? { label: String(e.priority), tone: "" }
              return (
                <div key={`${e.at}-${i}`}>
                  {newDay && <div className="log-day">{d}</div>}
                  <div className={`log-line${sev.tone ? ` log-${sev.tone}` : ""}`}>
                    <span className="log-time">{time(e.at)}</span>
                    <span className="log-sev">{sev.label}</span>
                    <span className="log-msg">{e.message}</span>
                  </div>
                </div>
              )
            })}
            <div ref={bottom} />
          </div>
        </>
      )}
    </div>
  )
}
