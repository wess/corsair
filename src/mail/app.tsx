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
import { del, formatBytes, get, patch, post } from "../web/lib/api.ts"

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
  recovery_address: string | null
  recovery_enabled: boolean
  uses_account_password: boolean
  /** Domains this mailbox may manage. Empty for almost everybody. */
  administers: { id: string; name: string }[]
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

// --------------------------------------------------------------- settings --

/**
 * Mailbox settings.
 *
 * This used to be a link to `/app`, which is the control panel — a surface a
 * mailbox identity has no account for and cannot sign into, so clicking your
 * own address logged you out in effect. A mailbox holder's settings belong to
 * the mailbox, and this is where they live.
 */
const Settings = ({ mailbox, onClose }: { mailbox: Mailbox; onClose: () => void }) => {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [done, setDone] = useState(false)

  const mismatch = confirm.length > 0 && next !== confirm

  return (
    <Dialog title="Mailbox settings" onClose={onClose}>
      <Field label="Address">
        <input value={mailbox.email} readOnly disabled />
      </Field>

      {mailbox.uses_account_password ? (
        /**
         * One credential, so it is not changed from two places. `setPassword`
         * refuses a linked mailbox outright, so offering the form here would be
         * offering a button that always fails.
         */
        <Banner>
          <Icon path={icons.account} size={15} />
          <span>
            This mailbox signs in with your account password. Change it at{" "}
            <a href="/app/account">Account settings</a> and it changes here too.
          </span>
        </Banner>
      ) : done ? (
        <Banner kind="good">
          Your password has been changed. Anywhere else you are already signed in — another browser,
          a mail client — keeps working until it next signs in.
        </Banner>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            if (mismatch) return
            setBusy(true)
            setError(null)
            try {
              await post("/api/mail/password", {
                current_password: current,
                new_password: next,
              })
              setDone(true)
              setCurrent("")
              setNext("")
              setConfirm("")
            } catch (err) {
              setError(err)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field label="Current password">
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoComplete="current-password"
            />
          </Field>
          <Field label="New password" hint="At least 8 characters.">
            <input
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Confirm new password">
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              autoComplete="new-password"
            />
          </Field>

          {mismatch && <ErrorText error="Those two do not match." />}
          <ErrorText error={error} />

          <button type="submit" className="btn btn-primary" disabled={busy || mismatch}>
            {busy ? <Spinner /> : "Change password"}
          </button>
        </form>
      )}

      <Recovery mailbox={mailbox} />
    </Dialog>
  )
}

/**
 * Where a reset link goes if this password is ever forgotten.
 *
 * Requires the current password for the same reason changing the password does:
 * whoever sets this can afterwards mail themselves a reset for this mailbox, so
 * an unattended signed-in session would otherwise be a full account takeover
 * rather than a read of today's mail.
 */
const Recovery = ({ mailbox }: { mailbox: Mailbox }) => {
  const [value, setValue] = useState(mailbox.recovery_address ?? "")
  const [current, setCurrent] = useState("")
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<unknown>(null)

  return (
    <div style={{ marginTop: 24, borderTop: "1px solid var(--line)", paddingTop: 18 }}>
      <h3 style={{ margin: "0 0 10px", fontSize: "0.95rem" }}>Recovery address</h3>

      {!mailbox.recovery_enabled && (
        <Banner kind="warn">
          Recovery is switched off for {mailbox.domain}. You can set an address here, but no reset
          link will be sent until whoever runs this domain turns it on.
        </Banner>
      )}

      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          setSaved(false)
          try {
            await post("/api/mail/recovery", {
              current_password: current,
              recovery_address: value.trim() || null,
            })
            setSaved(true)
            setCurrent("")
          } catch (err) {
            setError(err)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="Send reset links to"
          hint="Another mailbox you can reach — not this one. Leave it empty to turn recovery off for this mailbox."
        >
          <input
            type="email"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="you@somewhere-else.com"
          />
        </Field>
        <Field label="Confirm with your current password">
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
            autoComplete="current-password"
          />
        </Field>

        {saved && <Banner kind="good">Saved.</Banner>}
        <ErrorText error={error} />

        <button type="submit" className="btn" disabled={busy}>
          {busy ? <Spinner /> : "Save recovery address"}
        </button>
      </form>
    </div>
  )
}

// -------------------------------------------------------------------- users --

type ManagedUser = {
  id: string
  email: string
  local_part: string
  name: string | null
  type: string
  disabled: boolean
}

/**
 * Managing a domain's mailboxes without leaving the webmail.
 *
 * The person running a client's mail is a mailbox on that domain, and sending
 * them to the control panel meant a second password and a screenful of billing,
 * plans and DNS that are not theirs. This is the same job in the application
 * they already have open, with the credential they already use.
 *
 * It shows only what this mailbox may actually change — the server decides that
 * on every call, and a client that ignored the answer would get 404s.
 */
const Users = ({ mailbox, onClose }: { mailbox: Mailbox; onClose: () => void }) => {
  const [domainId, setDomainId] = useState(mailbox.administers[0]?.id ?? "")
  const [nonce, setNonce] = useState(0)
  const [adding, setAdding] = useState(false)
  const [localPart, setLocalPart] = useState("")
  const [name, setName] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [resetting, setResetting] = useState<ManagedUser | null>(null)
  const [newPassword, setNewPassword] = useState("")
  // Two-step rather than a confirm() — a modal dialog blocks the page, and
  // deleting a mailbox destroys its mail.
  const [confirming, setConfirming] = useState<string | null>(null)

  const { data, loading } = useLoad(
    () => get<{ data: ManagedUser[] }>(`/api/mail/admin/domains/${domainId}/users`),
    [domainId, nonce],
  )

  const domain = mailbox.administers.find((d) => d.id === domainId)
  const rows = data?.data ?? []
  const refresh = () => setNonce((n) => n + 1)

  return (
    <Dialog title={`Users on ${domain?.name ?? ""}`} onClose={onClose}>
      {mailbox.administers.length > 1 && (
        <Field label="Domain">
          <select value={domainId} onChange={(e) => setDomainId(e.target.value)}>
            {mailbox.administers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      {loading ? (
        <Loading />
      ) : (
        <table>
          <thead>
            <tr>
              <th>Address</th>
              <th>Name</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {row.email}
                  {row.disabled && <span className="muted"> · disabled</span>}
                </td>
                <td className="muted">{row.name ?? "—"}</td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  {row.type === "standard" && (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setResetting(row)
                        setNewPassword("")
                      }}
                    >
                      Password
                    </button>
                  )}{" "}
                  {/* Your own mailbox is deliberately neither disableable nor
                      deletable from here. The server refuses both; leaving the
                      buttons would be offering an action that always fails. */}
                  {row.email !== mailbox.email && (
                    <>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          await patch(`/api/mail/admin/users/${row.id}`, {
                            disabled: !row.disabled,
                          })
                          refresh()
                        }}
                      >
                        {row.disabled ? "Enable" : "Disable"}
                      </button>{" "}
                      {confirming === row.id ? (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={async () => {
                            await del(`/api/mail/admin/users/${row.id}`)
                            setConfirming(null)
                            refresh()
                          }}
                        >
                          Delete for good
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => setConfirming(row.id)}
                        >
                          Delete
                        </button>
                      )}
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {resetting && (
        <form
          style={{ marginTop: 16 }}
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              await post(`/api/mail/admin/users/${resetting.id}/password`, {
                password: newPassword,
              })
              setResetting(null)
              setNewPassword("")
              refresh()
            } catch (err) {
              setError(err)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field
            label={`New password for ${resetting.email}`}
            hint="At least 8 characters. Their mail client will need updating."
          >
            <input
              type="text"
              required
              minLength={8}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <ErrorText error={error} />
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {busy ? <Spinner /> : "Set password"}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setResetting(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {adding ? (
        <form
          style={{ marginTop: 16 }}
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              await post(`/api/mail/admin/domains/${domainId}/users`, {
                local_part: localPart,
                type: "standard",
                name: name || null,
                password,
              })
              setAdding(false)
              setLocalPart("")
              setName("")
              setPassword("")
              refresh()
            } catch (err) {
              setError(err)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field label="Address">
            <div className="row" style={{ flexWrap: "nowrap", alignItems: "center", gap: 6 }}>
              <input
                required
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value)}
                placeholder="firstname"
              />
              <span className="muted">@{domain?.name}</span>
            </div>
          </Field>
          <Field label="Name" hint="Optional — how it shows on their outgoing mail.">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Password" hint="At least 8 characters. Pass it on to them.">
            <input
              type="text"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <ErrorText error={error} />
          <div className="row" style={{ gap: 8 }}>
            <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
              {busy ? <Spinner /> : "Create mailbox"}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          style={{ marginTop: 16 }}
          onClick={() => {
            setAdding(true)
            setError(null)
          }}
        >
          Add a mailbox
        </button>
      )}
    </Dialog>
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
  const [settings, setSettings] = useState(false)
  const [users, setUsers] = useState(false)

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
          {mailbox.administers.length > 0 && (
            <button
              type="button"
              className="nav-item"
              onClick={() => setUsers(true)}
              title="Manage mailboxes"
            >
              <Icon path={icons.account} />
              Users
            </button>
          )}
          <button
            type="button"
            className="nav-item"
            onClick={() => setSettings(true)}
            title="Mailbox settings"
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

      {settings && <Settings mailbox={mailbox} onClose={() => setSettings(false)} />}

      {users && <Users mailbox={mailbox} onClose={() => setUsers(false)} />}

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
