import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  Banner,
  Card,
  Dialog,
  ErrorText,
  Field,
  Icon,
  icons,
  Loading,
  Spinner,
  useLoad,
} from "../web/components/index.tsx"
import { formatBytes, get, post } from "../web/lib/api.ts"

/**
 * Corsair Webmail.
 *
 * Reads the same store the IMAP server does, over the JSON API, authenticated
 * with the mailbox's own credential rather than a control-panel one. Message
 * bodies arrive already sanitised — this client never sees the original markup.
 */

type Mailbox = {
  email: string
  name: string | null
  domain: string
  quota_bytes: number
}

type Folder = {
  id: string
  name: string
  special_use: string | null
  total: number
  unseen: number
}

type Summary = {
  id: string
  folder_id: string
  subject: string | null
  from: string | null
  to: string[]
  snippet: string | null
  seen: boolean
  flagged: boolean
  answered: boolean
  draft: boolean
  size: number
  has_attachments: boolean
  date: string
}

type FullMessage = Summary & {
  headers: {
    from: string
    to: string
    cc: string
    reply_to: string
    date: string | null
    message_id: string | null
  }
  body_html: string
  body_text: string
  blocked_remote_images: boolean
  authentication: string | null
  attachments: {
    section: string
    filename: string
    content_type: string
    size: number
    inline: boolean
  }[]
}

const FOLDER_ICON: Record<string, string> = {
  inbox: icons.mail,
  sent: icons.logout,
  drafts: icons.plans,
  trash: icons.trash,
  junk: icons.warn,
  archive: icons.domains,
}

const shortDate = (value: string): string => {
  const date = new Date(value)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric" })
  }
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

/** "Wess Cope <me@wess.io>" reads better as just the name in a list. */
const displayName = (address: string | null): string => {
  if (!address) return "(unknown)"
  const angle = address.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/)
  if (angle) return (angle[1] ?? "").trim() || (angle[2] ?? "").trim()
  return address.trim()
}

const bareAddress = (address: string | null): string => {
  if (!address) return ""
  const angle = address.match(/<([^>]+)>/)
  return (angle?.[1] ?? address).trim()
}

// ------------------------------------------------------------------- login --

const LoginPage = ({ onSignedIn }: { onSignedIn: (mailbox: Mailbox) => void }) => {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <Card>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em" }}>✉️ Webmail</div>
            <div className="muted">Sign in with your mailbox address.</div>
          </div>

          <form
            onSubmit={async (e) => {
              e.preventDefault()
              setBusy(true)
              setError(null)
              try {
                await post("/api/mail/login", { email, password })
                onSignedIn(await get<Mailbox>("/api/mail/me"))
              } catch (e) {
                setError(e)
              } finally {
                setBusy(false)
              }
            }}
          >
            <Field label="Email" hint="Your full address, not just the part before the @.">
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
              />
            </Field>
            <Field
              label="Password"
              hint="Your account password if this mailbox is your own; otherwise the mailbox's own password."
            >
              <input
                required
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </Field>
            <ErrorText error={error} />
            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: "100%" }}
              disabled={busy}
            >
              {busy ? <Spinner /> : "Sign in"}
            </button>
          </form>

          <div style={{ marginTop: 16, textAlign: "center" }}>
            <a className="btn btn-ghost btn-sm" href="/recover">
              Forgot your mailbox password?
            </a>
          </div>
        </Card>
      </div>
    </div>
  )
}

// ----------------------------------------------------------------- reader --

const Reader = ({
  id,
  onChanged,
  onClose,
  onReply,
}: {
  id: string
  onChanged: () => void
  onClose: () => void
  onReply: (message: FullMessage, mode: "reply" | "replyAll" | "forward") => void
}) => {
  const [images, setImages] = useState(false)
  const { data, error, loading } = useLoad(
    () => get<FullMessage>(`/api/mail/messages/${id}${images ? "?images=true" : ""}`),
    [id, images],
  )

  // The sanitised body is injected as markup. It has already had scripts, event
  // handlers, and unsafe URLs removed on the server; this client never sees the
  // original.
  const bodyRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (bodyRef.current && data) bodyRef.current.innerHTML = data.body_html
  }, [data])

  useEffect(() => {
    if (data) onChanged()
  }, [data, onChanged])

  if (loading) return <Loading />
  if (error) return <ErrorText error={error} />
  if (!data) return null

  return (
    <>
      <div className="mail-reader-head">
        <div className="row spread" style={{ marginBottom: 10 }}>
          <div className="row">
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
              <Icon path={icons.back} size={15} />
            </button>
            <h2 style={{ margin: 0, fontSize: 19, letterSpacing: "-0.02em" }}>
              {data.subject || "(no subject)"}
            </h2>
          </div>
          <div className="row">
            <button type="button" className="btn btn-sm" onClick={() => onReply(data, "reply")}>
              Reply
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onReply(data, "replyAll")}>
              Reply all
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onReply(data, "forward")}>
              Forward
            </button>
          </div>
        </div>

        <div className="muted" style={{ fontSize: 14 }}>
          <strong>{displayName(data.headers.from)}</strong>{" "}
          <span className="faint">&lt;{bareAddress(data.headers.from)}&gt;</span>
        </div>
        <div className="faint" style={{ fontSize: 13 }}>
          to {data.headers.to || "(undisclosed)"}
          {data.headers.cc && `, cc ${data.headers.cc}`} · {new Date(data.date).toLocaleString()}
        </div>

        {data.authentication && (
          <details style={{ marginTop: 8 }}>
            <summary className="faint" style={{ fontSize: 12, cursor: "pointer" }}>
              Authentication results
            </summary>
            <div className="mono faint" style={{ fontSize: 12, marginTop: 4 }}>
              {data.authentication}
            </div>
          </details>
        )}
      </div>

      <div className="mail-reader-body">
        {data.blocked_remote_images && !images && (
          <div style={{ marginBottom: 16 }}>
            <Banner kind="warn">
              <Icon path={icons.warn} size={15} />
              <span>
                Remote images were not loaded. They can tell the sender when you opened this and
                from where.{" "}
                <button
                  type="button"
                  className="btn btn-sm btn-ghost"
                  onClick={() => setImages(true)}
                >
                  Load images
                </button>
              </span>
            </Banner>
          </div>
        )}

        {data.attachments.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            {data.attachments.map((attachment) => (
              <a
                key={attachment.section}
                className="mail-attachment"
                href={`/api/mail/messages/${data.id}/part/${attachment.section}`}
                download={attachment.filename}
              >
                <Icon path={icons.download} size={14} />
                <span>{attachment.filename}</span>
                <span className="faint">{formatBytes(attachment.size)}</span>
              </a>
            ))}
          </div>
        )}

        <div className="mail-body" ref={bodyRef} />

        <div className="row" style={{ marginTop: 24 }}>
          <a className="btn btn-sm btn-ghost" href={`/api/mail/messages/${data.id}/raw`}>
            Show original
          </a>
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- compose --

type Draft = {
  to: string
  cc: string
  bcc: string
  subject: string
  text: string
  inReplyTo?: string | null
  references?: string[]
}

const Compose = ({
  initial,
  onClose,
  onSent,
}: {
  initial: Draft
  onClose: () => void
  onSent: () => void
}) => {
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  const list = (value: string) =>
    value
      .split(/[,;]/)
      .map((v) => v.trim())
      .filter(Boolean)

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  return (
    <Dialog title="New message" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await post("/api/mail/send", {
              to: list(draft.to),
              cc: list(draft.cc),
              bcc: list(draft.bcc),
              subject: draft.subject,
              text: draft.text,
              in_reply_to: draft.inReplyTo ?? null,
              references: draft.references,
            })
            onSent()
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <div className="compose-grid">
          <div className="compose-row">
            <span>To</span>
            <input
              required
              value={draft.to}
              onChange={(e) => set({ to: e.target.value })}
              placeholder="someone@example.com"
            />
          </div>
          <div className="compose-row">
            <span>Cc</span>
            <input value={draft.cc} onChange={(e) => set({ cc: e.target.value })} />
          </div>
          <div className="compose-row">
            <span>Bcc</span>
            <input value={draft.bcc} onChange={(e) => set({ bcc: e.target.value })} />
          </div>
          <div className="compose-row">
            <span>Subject</span>
            <input value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />
          </div>
        </div>

        <textarea
          className="compose-body"
          value={draft.text}
          onChange={(e) => set({ text: e.target.value })}
          placeholder="Write your message…"
        />

        {saved && (
          <div style={{ marginBottom: 12 }}>
            <Banner kind="good">
              <Icon path={icons.check} size={15} />
              <span>Saved to Drafts.</span>
            </Banner>
          </div>
        )}
        <ErrorText error={error} />

        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : "Send"}
          </button>
          <button
            type="button"
            className="btn"
            onClick={async () => {
              await post("/api/mail/drafts", {
                to: list(draft.to),
                cc: list(draft.cc),
                subject: draft.subject,
                text: draft.text,
              })
              setSaved(true)
            }}
          >
            Save draft
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// ------------------------------------------------------------------ shell --

const App = () => {
  const [mailbox, setMailbox] = useState<Mailbox | null>(null)
  const [ready, setReady] = useState(false)
  const [folderId, setFolderId] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [compose, setCompose] = useState<Draft | null>(null)
  const [nonce, setNonce] = useState(0)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    get<Mailbox>("/api/mail/me")
      .then(setMailbox)
      .catch(() => setMailbox(null))
      .finally(() => setReady(true))
  }, [])

  const refresh = useCallback(() => setNonce((n) => n + 1), [])

  const folders = useLoad(
    () => (mailbox ? get<{ data: Folder[] }>("/api/mail/folders") : Promise.resolve(null)),
    [mailbox, nonce],
  )

  // Default to the inbox once the folder list arrives.
  useEffect(() => {
    if (!folderId && folders.data?.data.length) {
      const inbox = folders.data.data.find((f) => f.special_use === "inbox")
      setFolderId(inbox?.id ?? folders.data.data[0]!.id)
    }
  }, [folders.data, folderId])

  const messages = useLoad(
    () =>
      mailbox && folderId
        ? get<{ data: Summary[]; page: number; pages: number; total: number }>(
            `/api/mail/messages?folder_id=${folderId}&page=${page}${
              search ? `&search=${encodeURIComponent(search)}` : ""
            }`,
          )
        : Promise.resolve(null),
    [mailbox, folderId, page, search, nonce],
  )

  const currentFolder = useMemo(
    () => folders.data?.data.find((f) => f.id === folderId) ?? null,
    [folders.data, folderId],
  )

  const replyDraft = (message: FullMessage, mode: "reply" | "replyAll" | "forward"): Draft => {
    const quoted = (message.body_text || "")
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n")
    const attribution = `On ${new Date(message.date).toLocaleString()}, ${displayName(message.headers.from)} wrote:`

    if (mode === "forward") {
      return {
        to: "",
        cc: "",
        bcc: "",
        subject: `Fwd: ${message.subject ?? ""}`,
        text: `\n\n---------- Forwarded message ----------\nFrom: ${message.headers.from}\nDate: ${message.headers.date}\nSubject: ${message.subject ?? ""}\nTo: ${message.headers.to}\n\n${message.body_text}`,
      }
    }

    // Reply-all keeps the other recipients but never re-adds you to your own
    // reply, which is how a thread ends up with everyone talking to themselves.
    const others =
      mode === "replyAll"
        ? [...message.to, ...(message.headers.cc ? [message.headers.cc] : [])]
            .flatMap((v) => v.split(","))
            .map((v) => bareAddress(v.trim()))
            .filter((v) => v && v.toLowerCase() !== mailbox?.email.toLowerCase())
        : []

    return {
      to: bareAddress(message.headers.reply_to || message.headers.from),
      cc: [...new Set(others)].join(", "),
      bcc: "",
      subject: /^re:/i.test(message.subject ?? "")
        ? (message.subject ?? "")
        : `Re: ${message.subject ?? ""}`,
      text: `\n\n${attribution}\n${quoted}`,
      inReplyTo: message.headers.message_id,
      references: message.headers.message_id ? [message.headers.message_id] : undefined,
    }
  }

  const act = async (path: string, body: unknown) => {
    await post(path, body)
    setSelected(null)
    refresh()
  }

  if (!ready) return <Loading />
  if (!mailbox) return <LoginPage onSignedIn={setMailbox} />

  return (
    <div className={`mail${selected ? " reading" : ""}`}>
      <aside className="mail-folders">
        <div className="brand" style={{ padding: "4px 8px 14px" }}>
          ✉️ Webmail
        </div>

        <button
          type="button"
          className="btn btn-primary"
          style={{ marginBottom: 10 }}
          onClick={() => setCompose({ to: "", cc: "", bcc: "", subject: "", text: "" })}
        >
          <Icon path={icons.plus} size={15} /> Compose
        </button>

        {folders.data?.data.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className={`nav-item${folder.id === folderId ? " active" : ""}`}
            onClick={() => {
              setFolderId(folder.id)
              setSelected(null)
              setPage(1)
            }}
          >
            <Icon path={FOLDER_ICON[folder.special_use ?? ""] ?? icons.domains} />
            <span className="truncate" style={{ flex: 1 }}>
              {folder.name}
            </span>
            {folder.unseen > 0 && <span className="pill">{folder.unseen}</span>}
          </button>
        ))}

        <div className="sidebar-footer">
          <button type="button" className="nav-item" onClick={() => setCreating(true)}>
            <Icon path={icons.plus} />
            New folder
          </button>
          <button
            type="button"
            className="nav-item"
            onClick={() => (window.location.href = "/app")}
          >
            <Icon path={icons.account} />
            <span className="truncate">{mailbox.email}</span>
          </button>
          <button
            type="button"
            className="nav-item"
            onClick={async () => {
              await post("/api/mail/logout").catch(() => {})
              setMailbox(null)
            }}
          >
            <Icon path={icons.logout} />
            Sign out
          </button>
        </div>
      </aside>

      <section className="mail-list">
        <div className="mail-list-head">
          <input
            placeholder={`Search ${currentFolder?.name ?? "mail"}`}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
              setPage(1)
            }}
          />
          <button type="button" className="btn btn-sm" onClick={refresh} title="Refresh">
            <Icon path={icons.refresh} size={15} />
          </button>
        </div>

        <div className="mail-list-scroll">
          {messages.loading && (
            <div className="empty">
              <Spinner />
            </div>
          )}
          {!messages.loading && !messages.data?.data.length && (
            <div className="empty">{search ? "Nothing matches that." : "Nothing here yet."}</div>
          )}
          {messages.data?.data.map((message) => (
            <button
              key={message.id}
              type="button"
              className={`mail-item${message.seen ? "" : " unseen"}${
                message.id === selected ? " active" : ""
              }`}
              onClick={() => setSelected(message.id)}
            >
              <div className="mail-item-top">
                <span className="mail-from truncate">
                  {message.flagged && "★ "}
                  {currentFolder?.special_use === "sent" || currentFolder?.special_use === "drafts"
                    ? `To ${message.to.map(displayName).join(", ") || "(nobody)"}`
                    : displayName(message.from)}
                </span>
                <span className="mail-date">{shortDate(message.date)}</span>
              </div>
              <div className="mail-subject truncate">
                {message.has_attachments && "📎 "}
                {message.subject || "(no subject)"}
              </div>
              <div className="mail-snippet truncate">{message.snippet}</div>
            </button>
          ))}
        </div>

        {messages.data && messages.data.pages > 1 && (
          <div className="row spread" style={{ padding: 10, borderTop: "1px solid var(--border)" }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </button>
            <span className="muted">
              {messages.data.page} / {messages.data.pages}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page >= messages.data.pages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        )}
      </section>

      <section className="mail-reader">
        {selected ? (
          <>
            <div
              className="row"
              style={{ padding: "10px 24px 0", justifyContent: "flex-end", gap: 8 }}
            >
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  act("/api/mail/messages/flags", { ids: [selected], add: ["\\Flagged"] })
                }
              >
                ★ Flag
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  act("/api/mail/messages/flags", { ids: [selected], remove: ["\\Seen"] })
                }
              >
                Mark unread
              </button>
              <select
                className="btn btn-sm"
                style={{ width: "auto" }}
                defaultValue=""
                onChange={(e) => {
                  if (!e.target.value) return
                  void act("/api/mail/messages/move", {
                    ids: [selected],
                    folder_id: e.target.value,
                  })
                }}
              >
                <option value="">Move to…</option>
                {folders.data?.data
                  .filter((f) => f.id !== folderId)
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="btn btn-sm btn-danger"
                onClick={() => act("/api/mail/messages/delete", { ids: [selected] })}
              >
                <Icon path={icons.trash} size={14} /> Delete
              </button>
            </div>

            <Reader
              id={selected}
              onChanged={refresh}
              onClose={() => setSelected(null)}
              onReply={(message, mode) => setCompose(replyDraft(message, mode))}
            />
          </>
        ) : (
          <div className="mail-empty">
            <div>
              <div style={{ fontSize: 40, marginBottom: 8 }}>✉️</div>
              <div>Select a message to read it.</div>
              <div className="faint" style={{ marginTop: 6, fontSize: 13 }}>
                {formatBytes(mailbox.quota_bytes)} stored in this mailbox
              </div>
            </div>
          </div>
        )}
      </section>

      {compose && (
        <Compose
          initial={compose}
          onClose={() => setCompose(null)}
          onSent={() => {
            setCompose(null)
            refresh()
          }}
        />
      )}

      {creating && (
        <Dialog title="New folder" onClose={() => setCreating(false)}>
          <form
            onSubmit={async (e) => {
              e.preventDefault()
              const form = new FormData(e.currentTarget)
              await post("/api/mail/folders", { name: String(form.get("name") ?? "") })
              setCreating(false)
              refresh()
            }}
          >
            <Field label="Name">
              <input name="name" required autoFocus />
            </Field>
            <button type="submit" className="btn btn-primary">
              Create folder
            </button>
          </form>
        </Dialog>
      )}
    </div>
  )
}

// The webmail follows the system theme; there is no account row to read a
// stored preference from before signing in.
document.documentElement.dataset.theme = window.matchMedia?.("(prefers-color-scheme: light)")
  .matches
  ? "light"
  : "dark"

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
