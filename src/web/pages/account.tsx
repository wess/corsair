import { useState } from "react"
import type { Me } from "../app.tsx"
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
import { del, formatDate, get, patch, post } from "../lib/api.ts"

const TABS = [
  { key: "general", label: "General" },
  { key: "email", label: "Sign-in email" },
  { key: "totp", label: "Two-factor authentication" },
  { key: "password", label: "Change password" },
  { key: "notifications", label: "Notifications" },
  { key: "referrals", label: "Refer a friend" },
  { key: "sessions", label: "Sessions" },
] as const

export const AccountPage = ({
  me,
  onUpdated,
  onSignOut,
}: {
  me: Me
  onUpdated: (me: Me) => void
  onSignOut: () => void
}) => {
  const [tab, setTab] = useState<string>("general")

  return (
    <div className="page">
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

      {tab === "general" && <General me={me} onUpdated={onUpdated} onSignOut={onSignOut} />}
      {tab === "email" && <SignInEmail me={me} onUpdated={onUpdated} />}
      {tab === "totp" && <TwoFactor me={me} onUpdated={onUpdated} />}
      {tab === "password" && <ChangePassword />}
      {tab === "notifications" && <Notifications me={me} onUpdated={onUpdated} />}
      {tab === "referrals" && <Referrals />}
      {tab === "sessions" && <Sessions />}
    </div>
  )
}

const General = ({
  me,
  onUpdated,
  onSignOut,
}: {
  me: Me
  onUpdated: (me: Me) => void
  onSignOut: () => void
}) => {
  const [name, setName] = useState(me.name ?? "")
  const [notificationsEmail, setNotificationsEmail] = useState(me.notifications_email ?? "")
  const [theme, setTheme] = useState(me.theme)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [terminating, setTerminating] = useState(false)

  return (
    <>
      <Card title="Account status">
        <div className="row spread">
          <span className="muted">
            {me.status === "active"
              ? "Your account is active and in good standing."
              : "This account is not active."}
          </span>
          <Pill kind={me.status === "active" ? "good" : "bad"}>{me.status}</Pill>
        </div>
      </Card>

      <Card title="General">
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              onUpdated(
                await patch<Me>("/api/account", {
                  name: name || null,
                  notifications_email: notificationsEmail || null,
                  theme,
                }),
              )
            } catch (e) {
              setError(e)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field label="Full name">
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <Field
            label="Notifications email"
            hint="Where important notices go. Keep this somewhere other than this server, so an outage here does not stop you being told about it."
          >
            <input
              type="email"
              value={notificationsEmail}
              onChange={(e) => setNotificationsEmail(e.target.value)}
              placeholder={me.email}
            />
          </Field>

          <Field label="Theme">
            <div className="segmented">
              {(
                [
                  ["light", "Light mode"],
                  ["dark", "Dark mode"],
                  ["lights_out", "Lights out"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={theme === value ? "active" : ""}
                  onClick={() => {
                    setTheme(value)
                    // Applied immediately so the choice is visible before saving.
                    document.documentElement.dataset.theme = value
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>

          <ErrorText error={error} />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : "Update details"}
          </button>
        </form>
      </Card>

      <Card title="Danger zone">
        <div className="row spread">
          <span className="muted">
            Terminating stops mail immediately for every domain on this account.
          </span>
          <button type="button" className="btn btn-danger" onClick={() => setTerminating(true)}>
            Terminate account
          </button>
        </div>
      </Card>

      {terminating && (
        <TerminateDialog me={me} onClose={() => setTerminating(false)} onDone={onSignOut} />
      )}
    </>
  )
}

const TerminateDialog = ({
  me,
  onClose,
  onDone,
}: {
  me: Me
  onClose: () => void
  onDone: () => void
}) => {
  const [confirm, setConfirm] = useState("")
  const [error, setError] = useState<unknown>(null)

  return (
    <Dialog title="Terminate this account" onClose={onClose}>
      <Banner kind="bad">
        <Icon path={icons.warn} size={15} />
        <span>Every domain, mailbox, and message on this account stops working.</span>
      </Banner>
      <div style={{ height: 14 }} />
      <Field label={`Type ${me.email} to confirm`}>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </Field>
      <ErrorText error={error} />
      <button
        type="button"
        className="btn btn-danger"
        disabled={confirm !== me.email}
        onClick={async () => {
          try {
            await del(`/api/account?confirm=${encodeURIComponent(confirm)}`)
            onDone()
          } catch (e) {
            setError(e)
          }
        }}
      >
        Terminate permanently
      </button>
    </Dialog>
  )
}

const SignInEmail = ({ me, onUpdated }: { me: Me; onUpdated: (me: Me) => void }) => {
  const [email, setEmail] = useState(me.email)
  const [password, setPassword] = useState("")
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Card title="Sign-in email">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            onUpdated(await post<Me>("/api/account/email", { email, password }))
            setPassword("")
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Email" hint="Changing this signs out every other session.">
          <input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Current password">
          <input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner /> : "Update email"}
        </button>
      </form>
    </Card>
  )
}

const ChangePassword = () => {
  const [current, setCurrent] = useState("")
  const [next, setNext] = useState("")
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
            await post("/api/account/password", { current_password: current, new_password: next })
            setDone(true)
            setCurrent("")
            setNext("")
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Current password">
          <input
            required
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </Field>
        <Field label="New password" hint="At least 12 characters. Signs out every other session.">
          <input
            required
            minLength={12}
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
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

const TwoFactor = ({ me, onUpdated }: { me: Me; onUpdated: (me: Me) => void }) => {
  const [setup, setSetup] = useState<{ secret: string; otpauth_url: string } | null>(null)
  const [code, setCode] = useState("")
  const [password, setPassword] = useState("")
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  if (me.totp_enabled) {
    return (
      <Card title="Two-factor authentication">
        <Banner kind="good">
          <Icon path={icons.check} size={15} />
          <span>Two-factor authentication is on for this account.</span>
        </Banner>
        <div style={{ height: 16 }} />
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              await post("/api/auth/totp/disable", { password })
              onUpdated({ ...me, totp_enabled: false })
            } catch (e) {
              setError(e)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field label="Confirm with your password to turn it off">
            <input
              required
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <ErrorText error={error} />
          <button type="submit" className="btn btn-danger" disabled={busy}>
            {busy ? <Spinner /> : "Disable 2FA"}
          </button>
        </form>
      </Card>
    )
  }

  if (backupCodes) {
    return (
      <Card title="Save your backup codes">
        <Banner kind="warn">
          <Icon path={icons.warn} size={15} />
          <span>
            These are shown once. Each one works a single time, and they are the only way in if you
            lose your device.
          </span>
        </Banner>
        <div className="grid grid-3" style={{ margin: "16px 0" }}>
          {backupCodes.map((backup) => (
            <Copyable key={backup} value={backup} />
          ))}
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setBackupCodes(null)}>
          I have saved them
        </button>
      </Card>
    )
  }

  return (
    <Card title="Two-factor authentication">
      <p className="muted" style={{ marginTop: 0 }}>
        Two-factor authentication requires a time-based code from your device along with your
        password, so a stolen password alone is not enough to sign in.
      </p>

      {!setup && (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              setSetup(await post<{ secret: string; otpauth_url: string }>("/api/auth/totp/setup"))
            } catch (e) {
              setError(e)
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? <Spinner /> : "Set up 2FA"}
        </button>
      )}

      {setup && (
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              const result = await post<{ backup_codes: string[] }>("/api/auth/totp/enable", {
                code,
              })
              setBackupCodes(result.backup_codes)
              setSetup(null)
              onUpdated({ ...me, totp_enabled: true })
            } catch (e) {
              setError(e)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field
            label="Step 1 — add the key to your authenticator app"
            hint="Enter this secret manually, or open the link on a device with an authenticator installed."
          >
            <Copyable value={setup.secret} />
            <div style={{ height: 8 }} />
            <a href={setup.otpauth_url}>Open in an authenticator app</a>
          </Field>

          <Field label="Step 2 — confirm the code">
            <input
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              placeholder="000000"
            />
          </Field>

          <ErrorText error={error} />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : "Enable 2FA"}
          </button>
        </form>
      )}

      {!setup && <ErrorText error={error} />}
    </Card>
  )
}

const Notifications = ({ me, onUpdated }: { me: Me; onUpdated: (me: Me) => void }) => {
  const prefs = me.notification_prefs
  const [busy, setBusy] = useState<string | null>(null)

  const toggle = async (key: string, value: boolean) => {
    setBusy(key)
    try {
      onUpdated(await patch<Me>("/api/account/notifications", { [key]: value }))
    } finally {
      setBusy(null)
    }
  }

  const items = [
    ["referrals", "New referrals", "Tell me when somebody signs up with my referral link."],
    ["quota", "Storage warnings", "Tell me when an account is close to its storage limit."],
    ["security", "Security notices", "Tell me about new sign-ins and password changes."],
  ] as const

  return (
    <Card title="Notification settings">
      {items.map(([key, label, description]) => (
        <div key={key} className="field">
          <label className="row" style={{ gap: 8, cursor: "pointer" }}>
            <input
              type="checkbox"
              checked={prefs[key] !== false}
              onChange={(e) => toggle(key, e.target.checked)}
            />
            <span>{label}</span>
            {busy === key && <Spinner />}
          </label>
          <div className="hint">{description}</div>
        </div>
      ))}
    </Card>
  )
}

const Referrals = () => {
  const { data, loading, error } = useLoad(() =>
    get<{
      code: string
      link: string
      earned_months: number
      referrals: { id: string; email: string; rewarded: boolean; created_at: string }[]
    }>("/api/account/referrals"),
  )

  if (loading) return <Card title="Refer a friend">Loading…</Card>
  if (error) return <ErrorText error={error} />

  return (
    <>
      <Card title="Refer a friend">
        <p className="muted" style={{ marginTop: 0 }}>
          Send this link to a friend. When they choose a plan, you both get another month of free
          service.
        </p>
        <Field label="Your personal referral link">
          <Copyable value={data?.link ?? ""} />
        </Field>
        <div className="row spread">
          <span className="muted">Free months earned</span>
          <span className="stat" style={{ fontSize: 22 }}>
            {data?.earned_months ?? 0}
          </span>
        </div>
      </Card>

      <Card title="Referrals" bodyless>
        <table>
          <thead>
            <tr>
              <th>Friend</th>
              <th>Joined</th>
              <th>Reward</th>
            </tr>
          </thead>
          <tbody>
            {!data?.referrals.length && (
              <tr>
                <td colSpan={3} className="empty">
                  Nobody has used your link yet.
                </td>
              </tr>
            )}
            {data?.referrals.map((r) => (
              <tr key={r.id}>
                <td className="mono">{r.email}</td>
                <td className="muted">{formatDate(r.created_at)}</td>
                <td>
                  <Pill kind={r.rewarded ? "good" : "warn"}>
                    {r.rewarded ? "granted" : "pending"}
                  </Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  )
}

const Sessions = () => {
  const { data, loading, error, reload } = useLoad(() =>
    get<{
      data: {
        id: string
        current: boolean
        ip: string | null
        user_agent: string | null
        created_at: string
        last_used_at: string | null
      }[]
    }>("/api/account/sessions"),
  )

  if (loading) return <Card title="Sessions">Loading…</Card>
  if (error) return <ErrorText error={error} />

  return (
    <Card
      title="Active sessions"
      actions={
        <button
          type="button"
          className="btn btn-sm btn-danger"
          onClick={async () => {
            await post("/api/account/sessions/revoke-others")
            reload()
          }}
        >
          Sign out everywhere else
        </button>
      }
      bodyless
    >
      <table>
        <thead>
          <tr>
            <th>Device</th>
            <th>Address</th>
            <th>Last used</th>
          </tr>
        </thead>
        <tbody>
          {data?.data.map((session) => (
            <tr key={session.id}>
              <td className="truncate" style={{ maxWidth: 340 }}>
                {session.user_agent ?? "Unknown"}
                {session.current && (
                  <>
                    {" "}
                    <Pill kind="good">this device</Pill>
                  </>
                )}
              </td>
              <td className="mono muted">{session.ip ?? "—"}</td>
              <td className="muted">{formatDate(session.last_used_at ?? session.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}
