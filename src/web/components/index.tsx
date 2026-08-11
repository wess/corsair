import { type ReactNode, useCallback, useEffect, useRef, useState } from "react"
import { type Page, RequestError } from "../lib/api.ts"

// Single-path icons, inlined. A dependency for twelve glyphs is not worth the
// bytes or the supply chain.
export const icons = {
  overview: "M3 3h8v8H3zM13 3h8v5h-8zM13 10h8v11h-8zM3 13h8v8H3z",
  domains: "M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5",
  filters: "M3 4h18l-7 8v7l-4 2v-9z",
  transfers: "M7 4 3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7",
  account: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 3a4 4 0 1 1 0 8 4 4 0 0 1 0-8",
  plans: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  billing: "M2 7h20v12H2zM2 11h20",
  docs: "M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01",
  mail: "M2 5h20v14H2zM2 6l10 7 10-7",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  check: "m20 6-11 11-5-5",
  copy: "M9 9h11v11H9zM5 15H4V4h11v1",
  plus: "M12 5v14M5 12h14",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  back: "m15 18-6-6 6-6",
  warn: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0",
  eye: "M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6",
  refresh: "M21 12a9 9 0 1 1-3-6.7M21 3v6h-6",
  download: "M12 3v12M7 10l5 5 5-5M4 21h16",
  webhook:
    "M18 16.98h-5.99M6 8a3 3 0 1 1 5.2 2.05L9 14M15.5 12a3 3 0 1 1 1.5 5.6M8.5 17a3 3 0 1 1-2.6-4.5",
} as const

export const Icon = ({ path, size = 17 }: { path: string; size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={path} />
  </svg>
)

export const Spinner = () => <span className="spinner" />

export const Loading = () => (
  <div className="center">
    <Spinner />
  </div>
)

export const Card = ({
  title,
  actions,
  children,
  bodyless,
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  bodyless?: boolean
}) => (
  <section className="card">
    {(title || actions) && (
      <header className="card-head">
        <span>{title}</span>
        {actions}
      </header>
    )}
    {bodyless ? children : <div className="card-body">{children}</div>}
  </section>
)

export const Field = ({
  label,
  hint,
  children,
}: {
  label: string
  hint?: ReactNode
  children: ReactNode
}) => (
  <div className="field">
    {/* Wrapping the control gives implicit label association, which is what
        makes the field usable with a screen reader and clickable by its text.
        `children` is an opaque ReactNode, so that cannot be checked statically. */}
    {/* biome-ignore lint/a11y/noLabelWithoutControl: the control is passed in as children */}
    <label>
      <span className="label-text">{label}</span>
      {children}
    </label>
    {hint && <div className="hint">{hint}</div>}
  </div>
)

export const Banner = ({
  kind = "info",
  children,
}: {
  kind?: "info" | "warn" | "bad" | "good"
  children: ReactNode
}) => <div className={`banner${kind === "info" ? "" : ` banner-${kind}`}`}>{children}</div>

export const Pill = ({
  kind = "neutral",
  children,
}: {
  kind?: "neutral" | "good" | "warn" | "bad"
  children: ReactNode
}) => <span className={`pill${kind === "neutral" ? "" : ` pill-${kind}`}`}>{children}</span>

export const statusPill = (status: string) => {
  const kind =
    status === "active" || status === "ok"
      ? "good"
      : status === "failed" || status === "missing" || status === "mismatch"
        ? "bad"
        : "warn"
  return <Pill kind={kind}>{status.replace(/_/g, " ")}</Pill>
}

/** Copies on click and says so, because a silent copy button is untrustworthy. */
export const Copyable = ({ value, label }: { value: string; label?: string }) => {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="copy mono truncate"
      title={value}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1400)
        })
      }}
    >
      <Icon path={copied ? icons.check : icons.copy} size={13} />
      <span className="truncate">{label ?? value}</span>
    </button>
  )
}

export const Dialog = ({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) => {
  const ref = useRef<HTMLDialogElement>(null)

  // The native element handles modality, focus containment, Escape, and the
  // backdrop. Doing any of that by hand on a div is how a modal ends up
  // unusable with a keyboard.
  useEffect(() => {
    const node = ref.current
    if (node && !node.open) node.showModal()
  }, [])

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path is Escape, handled natively by <dialog>, plus the focusable Close button
    <dialog
      ref={ref}
      className="dialog"
      onClose={onClose}
      onClick={(e) => {
        // A click that lands on the dialog itself rather than its content is a
        // click on the backdrop, which the element reports as its own target.
        if (e.target === ref.current) onClose()
      }}
    >
      <div className="card">
        <header className="card-head">
          <span>{title}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="card-body">{children}</div>
      </div>
    </dialog>
  )
}

export const Toast = ({ message, onDone }: { message: string; onDone: () => void }) => {
  useEffect(() => {
    const timer = setTimeout(onDone, 4000)
    return () => clearTimeout(timer)
  }, [onDone])
  return <div className="toast">{message}</div>
}

export const ErrorText = ({ error }: { error: unknown }) => {
  if (!error) return null
  const message = error instanceof Error ? error.message : String(error)
  return (
    <Banner kind={error instanceof RequestError && error.needsUpgrade ? "warn" : "bad"}>
      <Icon path={icons.warn} size={15} />
      <span>{message}</span>
    </Banner>
  )
}

/** Fetches on mount and whenever a dependency changes, with a manual reload. */
export const useLoad = <T,>(
  loader: () => Promise<T>,
  deps: unknown[] = [],
): { data: T | null; error: unknown; loading: boolean; reload: () => void } => {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)
  const [nonce, setNonce] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are supplied by the caller, and `nonce` is the manual-reload trigger
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    loader()
      .then((value) => {
        if (!cancelled) {
          setData(value)
          setError(null)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [...deps, nonce])

  return { data, error, loading, reload: useCallback(() => setNonce((n) => n + 1), []) }
}

export type Column<T> = {
  key: string
  label: string
  sortable?: boolean
  render: (row: T) => ReactNode
}

/**
 * The list view every screen uses: search, sortable headers, per-page, paging.
 * Sorting and paging are server-side, so this holds the query and reports it
 * upward rather than slicing rows itself.
 */
export const DataTable = <T,>({
  columns,
  page,
  loading,
  query,
  onQuery,
  emptyText,
  onRowClick,
  actions,
}: {
  columns: Column<T>[]
  page: Page<T> | null
  loading: boolean
  query: {
    search: string
    sort: string | null
    direction: "asc" | "desc"
    page: number
    perPage: number
  }
  onQuery: (next: Partial<typeof query>) => void
  emptyText: string
  onRowClick?: (row: T) => void
  actions?: ReactNode
}) => {
  const toggleSort = (key: string) => {
    if (query.sort === key) {
      onQuery({ direction: query.direction === "asc" ? "desc" : "asc" })
      return
    }
    onQuery({ sort: key, direction: "asc", page: 1 })
  }

  return (
    <>
      <div className="row spread">
        <input
          style={{ maxWidth: 320 }}
          placeholder="Search"
          value={query.search}
          onChange={(e) => onQuery({ search: e.target.value, page: 1 })}
        />
        {actions}
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  onClick={column.sortable ? () => toggleSort(column.key) : undefined}
                  style={{ cursor: column.sortable ? "pointer" : "default" }}
                >
                  {column.label}
                  {query.sort === column.key ? (query.direction === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={columns.length} className="empty">
                  <Spinner />
                </td>
              </tr>
            )}
            {!loading && !page?.data.length && (
              <tr>
                <td colSpan={columns.length} className="empty">
                  {emptyText}
                </td>
              </tr>
            )}
            {!loading &&
              page?.data.map((row, index) => (
                <tr
                  // Every row this table serves is an API object with an id.
                  // The index is only a fallback so a malformed row still
                  // renders rather than collapsing the list.
                  key={(row as { id?: string }).id ?? `row-${index}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  style={{ cursor: onRowClick ? "pointer" : "default" }}
                >
                  {columns.map((column) => (
                    <td key={column.key}>{column.render(row)}</td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <div className="row spread">
        <select
          style={{ width: 130 }}
          value={query.perPage}
          onChange={(e) => onQuery({ perPage: Number(e.target.value), page: 1 })}
        >
          {[10, 25, 50, 100].map((n) => (
            <option key={n} value={n}>
              {n} per page
            </option>
          ))}
        </select>

        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            disabled={query.page <= 1}
            onClick={() => onQuery({ page: query.page - 1 })}
          >
            Previous
          </button>
          <span className="muted">
            Page {page?.page ?? 1} of {page?.pages ?? 1}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={!page || query.page >= page.pages}
            onClick={() => onQuery({ page: query.page + 1 })}
          >
            Next
          </button>
        </div>
      </div>
    </>
  )
}

/**
 * A 30-day activity chart as an inline SVG.
 *
 * Two series over a fixed window with no interaction — a charting library would
 * be twenty times the size of the thing it draws.
 */
export const Sparkline = ({
  days,
  height = 140,
}: {
  days: { day: string; sent: number; received: number }[]
  height?: number
}) => {
  if (!days.length) return <div className="empty">No activity yet.</div>

  const width = 640
  const max = Math.max(1, ...days.map((d) => Math.max(d.sent, d.received)))
  const step = width / Math.max(1, days.length - 1)
  const y = (value: number) => height - (value / max) * (height - 12) - 6

  const line = (pick: (d: (typeof days)[number]) => number) =>
    days
      .map((d, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(pick(d)).toFixed(1)}`)
      .join(" ")

  const area = (pick: (d: (typeof days)[number]) => number) =>
    `${line(pick)} L${width},${height} L0,${height} Z`

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      role="img"
      aria-label="Messages sent and received over the last 30 days"
      preserveAspectRatio="none"
    >
      <title>Messages sent and received over the last 30 days</title>
      <path d={area((d) => d.received)} fill="var(--accent)" opacity="0.12" />
      <path
        d={line((d) => d.received)}
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
      <path
        d={line((d) => d.sent)}
        fill="none"
        stroke="var(--good)"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
