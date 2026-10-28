import { useState } from "react"
import {
  Banner,
  Card,
  Copyable,
  Dialog,
  ErrorText,
  Field,
  Icon,
  icons,
  Pill,
  Spinner,
  useLoad,
} from "../components/index.tsx"
import { del, formatDate, get, post } from "../lib/api.ts"

type AppPassword = {
  id: string
  name: string
  scopes: string[]
  last_used_at: string | null
  last_used_ip: string | null
  created_at: string
}

type Listing = {
  data: AppPassword[]
  require_app_passwords: boolean
  totp_recommended?: boolean
}

const SCOPES: { id: string; label: string }[] = [
  { id: "imap", label: "IMAP" },
  { id: "pop3", label: "POP3" },
  { id: "smtp", label: "SMTP" },
  { id: "jmap", label: "JMAP" },
  { id: "dav", label: "Contacts" },
  { id: "sieve", label: "Filters" },
]

/**
 * App passwords, shared by the panel's address page and the webmail settings.
 *
 * `base` is the collection URL for whichever side is asking. The webmail passes
 * `confirmWithPassword`, because a mailbox session that could mint a credential
 * outliving a password change needs the password itself to do it. Only the
 * panel passes `onRequire`: whether the real password still works on the mail
 * protocols is the mailbox administrator's call.
 */
export const AppPasswords = ({
  base,
  email,
  confirmWithPassword = false,
  onRequire,
  bare = false,
}: {
  base: string
  email: string
  confirmWithPassword?: boolean
  onRequire?: (value: boolean) => Promise<void>
  /** Render without a Card, for use inside a dialog. */
  bare?: boolean
}) => {
  const listing = useLoad(() => get<Listing>(base), [base])
  const [creating, setCreating] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try {
      await work()
      listing.reload()
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  const rows = listing.data?.data ?? []
  const required = listing.data?.require_app_passwords ?? false

  const body = (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        One password per mail client. Each opens IMAP, SMTP and the other mail protocols on its own,
        and deleting one signs out only that device. Changing the mailbox password leaves them
        working.
      </p>

      {listing.data?.totp_recommended && (
        <Banner kind="warn">
          <Icon path={icons.warn} size={15} />
          <span>
            This mailbox signs in with an account password that has two-step sign-in, but mail
            clients take that password with no second step. Create an app password for each client,
            then require them below.
          </span>
        </Banner>
      )}

      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Opens</th>
            <th>Last used</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {listing.loading && (
            <tr>
              <td colSpan={4} className="empty">
                <Spinner />
              </td>
            </tr>
          )}
          {!listing.loading && rows.length === 0 && (
            <tr>
              <td colSpan={4} className="empty">
                No app passwords yet.
              </td>
            </tr>
          )}
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <strong>{row.name}</strong>
                <div className="faint">created {formatDate(row.created_at)}</div>
              </td>
              <td>
                {row.scopes.length === SCOPES.length ? (
                  <Pill>everything</Pill>
                ) : (
                  row.scopes.map((s) => (
                    <span key={s}>
                      <Pill>{SCOPES.find((x) => x.id === s)?.label ?? s}</Pill>{" "}
                    </span>
                  ))
                )}
              </td>
              <td className="muted">
                {row.last_used_at ? formatDate(row.last_used_at) : "never"}
                {row.last_used_ip && <div className="faint mono">{row.last_used_ip}</div>}
              </td>
              <td style={{ textAlign: "right" }}>
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete "${row.name}"? That client stops signing in.`)) {
                      void run(() => del(`${base}/${row.id}`))
                    }
                  }}
                >
                  <Icon path={icons.trash} size={14} /> Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="row" style={{ marginTop: 14, gap: 8 }}>
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
          <Icon path={icons.plus} size={15} /> New app password
        </button>
      </div>

      {onRequire && (
        <div style={{ marginTop: 18 }}>
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={required}
              disabled={busy}
              onChange={(e) => {
                const next = e.target.checked
                void run(() => onRequire(next))
              }}
            />
            Require app passwords for mail clients
          </label>
          <div className="faint" style={{ marginTop: 4 }}>
            The mailbox password stops working in IMAP, POP3, SMTP and JMAP clients. The webmail
            still takes it.
          </div>
        </div>
      )}

      <ErrorText error={error} />

      {creating && (
        <CreateAppPassword
          base={base}
          confirmWithPassword={confirmWithPassword}
          onClose={() => setCreating(false)}
          onCreated={(password) => {
            setCreating(false)
            setShown(password)
            listing.reload()
          }}
        />
      )}

      {shown && (
        <Dialog title="Save this app password" onClose={() => setShown(null)}>
          <Banner kind="warn">
            <Icon path={icons.warn} size={15} />
            <span>It is shown once. A lost one is deleted and replaced, never recovered.</span>
          </Banner>
          <div style={{ margin: "16px 0", display: "grid", gap: 12 }}>
            <Field label="Username">
              <Copyable value={email} />
            </Field>
            <Field
              label="Password"
              hint="Type it into the mail client's password field. Dashes and capitals do not matter."
            >
              <Copyable value={shown} />
            </Field>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setShown(null)}>
            I have saved it
          </button>
        </Dialog>
      )}
    </>
  )

  return bare ? body : <Card title="App passwords">{body}</Card>
}

const CreateAppPassword = ({
  base,
  confirmWithPassword,
  onClose,
  onCreated,
}: {
  base: string
  confirmWithPassword: boolean
  onClose: () => void
  onCreated: (password: string) => void
}) => {
  const [name, setName] = useState("")
  const [scopes, setScopes] = useState<string[]>(SCOPES.map((s) => s.id))
  const [current, setCurrent] = useState("")
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Dialog title="New app password" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            const created = await post<{ password: string }>(base, {
              name: name.trim(),
              scopes,
              ...(confirmWithPassword ? { current_password: current } : {}),
            })
            onCreated(created.password)
          } catch (err) {
            setError(err)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Name" hint="The device or app it is for, so you know which one to delete.">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="iPhone Mail"
            maxLength={64}
            required
          />
        </Field>

        <Field label="Opens">
          <div className="row" style={{ gap: 14, flexWrap: "wrap" }}>
            {SCOPES.map((s) => (
              <label key={s.id} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={scopes.includes(s.id)}
                  onChange={(e) =>
                    setScopes(
                      e.target.checked ? [...scopes, s.id] : scopes.filter((x) => x !== s.id),
                    )
                  }
                />
                {s.label}
              </label>
            ))}
          </div>
        </Field>

        {confirmWithPassword && (
          <Field label="Confirm with your current password">
            <input
              type="password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
              autoComplete="current-password"
            />
          </Field>
        )}

        <ErrorText error={error} />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !name.trim() || scopes.length === 0}
        >
          {busy ? <Spinner /> : "Create app password"}
        </button>
      </form>
    </Dialog>
  )
}
