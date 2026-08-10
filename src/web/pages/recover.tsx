import { useState } from "react"
import { Banner, Card, ErrorText, Field, Icon, icons, Spinner } from "../components/index.tsx"
import { generatePassword, post } from "../lib/api.ts"

/**
 * The unauthenticated flows: forgot password, reset, and verify.
 *
 * These render before the sign-in gate, because somebody who has lost their
 * password cannot sign in to reach them.
 */

const Frame = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="auth-wrap">
    <div className="auth-card">
      <Card>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em" }}>🏴 Corsair</div>
          <div className="muted">{title}</div>
        </div>
        {children}
      </Card>
    </div>
  </div>
)

export const ForgotPasswordPage = ({ onBack }: { onBack: () => void }) => {
  const [email, setEmail] = useState("")
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  if (sent) {
    return (
      <Frame title="Check your email">
        <Banner kind="good">
          <Icon path={icons.check} size={15} />
          <span>
            If that address has an account, a reset link is on its way. It is good for one hour.
          </span>
        </Banner>
        <div style={{ height: 16 }} />
        <button type="button" className="btn" style={{ width: "100%" }} onClick={onBack}>
          Back to sign in
        </button>
      </Frame>
    )
  }

  return (
    <Frame title="Reset your password">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await post("/api/auth/password/forgot", { email })
            setSent(true)
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Email" hint="The address you sign in with.">
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="username"
          />
        </Field>
        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary" style={{ width: "100%" }} disabled={busy}>
          {busy ? <Spinner /> : "Send reset link"}
        </button>
      </form>
      <div style={{ marginTop: 16, textAlign: "center" }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onBack}>
          Back to sign in
        </button>
      </div>
    </Frame>
  )
}

export const ResetPasswordPage = ({ token, onDone }: { token: string; onDone: () => void }) => {
  const [password, setPassword] = useState("")
  const [done, setDone] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  if (done) {
    return (
      <Frame title="Password changed">
        <Banner kind="good">
          <Icon path={icons.check} size={15} />
          <span>Your password has been changed. Every other session was signed out.</span>
        </Banner>
        <div style={{ height: 16 }} />
        <button
          type="button"
          className="btn btn-primary"
          style={{ width: "100%" }}
          onClick={onDone}
        >
          Sign in
        </button>
      </Frame>
    )
  }

  return (
    <Frame title="Choose a new password">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await post("/api/auth/password/reset", { token, password })
            setDone(true)
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="New password" hint="At least 12 characters.">
          <input
            required
            minLength={12}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary" style={{ width: "100%" }} disabled={busy}>
          {busy ? <Spinner /> : "Change password"}
        </button>
      </form>
    </Frame>
  )
}

export const VerifyEmailPage = ({ token, onDone }: { token: string; onDone: () => void }) => {
  const [state, setState] = useState<"idle" | "ok" | "failed">("idle")
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Frame title="Confirm your email address">
      {state === "ok" ? (
        <>
          <Banner kind="good">
            <Icon path={icons.check} size={15} />
            <span>Your email address is confirmed.</span>
          </Banner>
          <div style={{ height: 16 }} />
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: "100%" }}
            onClick={onDone}
          >
            Continue
          </button>
        </>
      ) : (
        <>
          <ErrorText error={error} />
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: "100%" }}
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              setError(null)
              try {
                await post("/api/auth/verify", { token })
                setState("ok")
              } catch (e) {
                setError(e)
                setState("failed")
              } finally {
                setBusy(false)
              }
            }}
          >
            {busy ? <Spinner /> : "Confirm this address"}
          </button>
        </>
      )}
    </Frame>
  )
}

/**
 * Mailbox recovery, for somebody who is not a control-panel user at all — they
 * own an address on a hosted domain and have lost its password.
 */
export const AddressRecoveryPage = () => {
  const params = new URLSearchParams(window.location.search)
  const token = params.get("token") ?? ""
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [show, setShow] = useState(false)
  const [sent, setSent] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  if (done) {
    return (
      <Frame title="Mailbox password changed">
        <Banner kind="good">
          <Icon path={icons.check} size={15} />
          <span>
            The password for <strong>{done}</strong> has been changed. Update it in every mail
            client signed in as this mailbox.
          </span>
        </Banner>
      </Frame>
    )
  }

  if (token) {
    return (
      <Frame title="Choose a new mailbox password">
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              const result = await post<{ mailbox: string }>("/api/recover/reset", {
                token,
                password,
              })
              setDone(result.mailbox)
            } catch (e) {
              setError(e)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field label="New password" hint="At least 8 characters.">
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
          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: "100%" }}
            disabled={busy}
          >
            {busy ? <Spinner /> : "Change mailbox password"}
          </button>
        </form>
      </Frame>
    )
  }

  if (sent) {
    return (
      <Frame title="Check your recovery address">
        <Banner kind="good">
          <Icon path={icons.check} size={15} />
          <span>
            If that mailbox exists and has recovery enabled, a link is on its way to its recovery
            address. It is good for one hour.
          </span>
        </Banner>
      </Frame>
    )
  }

  return (
    <Frame title="Recover a mailbox password">
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await post("/api/recover/request", { email })
            setSent(true)
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="Mailbox address"
          hint="The link goes to the recovery address your administrator set for this mailbox, not to the mailbox itself."
        >
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>
        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary" style={{ width: "100%" }} disabled={busy}>
          {busy ? <Spinner /> : "Send recovery link"}
        </button>
      </form>
    </Frame>
  )
}
