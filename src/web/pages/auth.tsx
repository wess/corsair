import { useEffect, useState } from "react"
import type { Me } from "../app.tsx"
import { Card, ErrorText, Field, Spinner } from "../components/index.tsx"
import { get, post } from "../lib/api.ts"

type Mode = "login" | "signup"

export const AuthPage = ({
  onAuthenticated,
  onForgot,
}: {
  onAuthenticated: (me: Me) => void
  onForgot: () => void
}) => {
  const referredBy = new URLSearchParams(window.location.search).get("referred_by") ?? ""
  const [mode, setMode] = useState<Mode>("login")
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  // Set once the server says the password was right but a second factor is
  // needed, so the form can switch to asking for it without losing state.
  const [needsCode, setNeedsCode] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  // Whether this server would accept a signup. Undefined until the answer
  // arrives; the toggle stays hidden until then rather than appearing and then
  // vanishing, which reads as a glitch.
  const [signupsOpen, setSignupsOpen] = useState<boolean | undefined>(undefined)

  useEffect(() => {
    let live = true
    get<{ open: boolean }>("/api/auth/signups")
      .then((r) => live && setSignupsOpen(r.open))
      // A server too old to have the endpoint, or one that is briefly
      // unreachable, should not lose the only way to make the first account.
      .catch(() => live && setSignupsOpen(true))
    return () => {
      live = false
    }
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (mode === "signup") {
        const me = await post<Me>("/api/auth/signup", {
          email,
          password,
          name: name || undefined,
          referred_by: referredBy || undefined,
        })
        onAuthenticated(me)
        return
      }

      const result = await post<Me | { object: "challenge"; totp_required: boolean }>(
        "/api/auth/login",
        { email, password, code: code || undefined },
      )
      if ("object" in result && result.object === "challenge") {
        setNeedsCode(true)
        return
      }
      onAuthenticated(result as Me)
    } catch (e) {
      setError(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <Card>
          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em" }}>
              🏴 Corsair
            </div>
            <div className="muted">Email hosting on your own domains.</div>
          </div>

          <form onSubmit={submit}>
            {mode === "signup" && (
              <Field label="Name">
                <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
              </Field>
            )}

            <Field label="Email">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
              />
            </Field>

            <Field
              label="Password"
              hint={mode === "signup" ? "At least 12 characters." : undefined}
            >
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
            </Field>

            {needsCode && (
              <Field label="Two-factor code" hint="From your authenticator app, or a backup code.">
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  // biome-ignore lint/a11y/noAutofocus: the field just appeared and is the only thing left to do
                  autoFocus
                />
              </Field>
            )}

            {error != null && (
              <div style={{ marginBottom: 14 }}>
                <ErrorText error={error} />
              </div>
            )}

            <button
              type="submit"
              className="btn btn-primary"
              style={{ width: "100%" }}
              disabled={busy}
            >
              {busy ? <Spinner /> : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>

          <div style={{ marginTop: 16, textAlign: "center" }}>
            {mode === "login" && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={onForgot}>
                Forgot your password?
              </button>
            )}
            {signupsOpen && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setMode(mode === "login" ? "signup" : "login")
                  setNeedsCode(false)
                  setError(null)
                }}
              >
                {mode === "login" ? "Create an account" : "I already have an account"}
              </button>
            )}
          </div>

          {referredBy && mode === "signup" && (
            <div className="hint" style={{ textAlign: "center" }}>
              Referred by <span className="mono">{referredBy}</span>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
