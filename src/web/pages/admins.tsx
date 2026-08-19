import { useState } from "react"
import {
  Banner,
  Card,
  ErrorText,
  Field,
  Icon,
  icons,
  Loading,
  Spinner,
  useLoad,
} from "../components/index.tsx"
import { del, get, post, RequestError } from "../lib/api.ts"

/**
 * Who else may act on this server.
 *
 * The owner's screen. Domain-level delegation lives on the domain itself, where
 * the person granting it already is — this page is only for the grant that
 * crosses every account.
 */

type Admin = {
  /**
   * Exactly one of these is set. A server-wide grant is always an account; a
   * domain grant is usually a mailbox, which is the whole point — the person
   * running a client's mail has no panel account and does not need one.
   */
  user_id: string | null
  address_id?: string | null
  subject?: "account" | "mailbox"
  email: string
  name: string | null
  status?: string
  is_owner?: boolean
  is_admin?: boolean
  granted_at: string | null
}

export const AdminsPage = () => {
  const { data, loading, error, reload } = useLoad(() => get<{ data: Admin[] }>("/api/admins"))
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<unknown>(null)

  if (loading) return <Loading />
  if (error) return <ErrorText error={error} />

  const admins = data?.data ?? []

  return (
    <>
      <Card title="Server administrators">
        <p className="muted" style={{ marginTop: 0 }}>
          A server administrator manages the mailboxes on every domain this server hosts. They do
          not get billing, plans, or the ability to delete a domain — those stay with whoever owns
          the thing being spent or destroyed.
        </p>

        {admins.length === 0 ? (
          <Banner>
            <Icon path={icons.account} size={15} />
            <span>Nobody but you. Add an account below to delegate.</span>
          </Banner>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Account</th>
                <th>Scope</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {admins.map((admin) => (
                <tr key={admin.user_id}>
                  <td>
                    <div>{admin.email}</div>
                    {admin.name && <div className="muted">{admin.name}</div>}
                  </td>
                  <td>{admin.is_owner ? "Owner" : "Every domain"}</td>
                  <td style={{ textAlign: "right" }}>
                    {admin.is_owner ? (
                      <span className="muted">Cannot be revoked</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          await del(`/api/admins/${admin.user_id}`)
                          reload()
                        }}
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Add an administrator">
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setFormError(null)
            try {
              if (creating) await post("/api/users", { email, password })
              await post("/api/admins", { email })
              setEmail("")
              setPassword("")
              setCreating(false)
              reload()
            } catch (err) {
              if (!creating && err instanceof RequestError && err.status === 404) {
                setCreating(true)
                setFormError(null)
              } else {
                setFormError(err)
              }
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field
            label="Account email"
            hint="A panel sign-in address. Server administration is an account-level grant, so unlike a single domain it cannot be given to a mailbox."
          >
            <input
              type="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value)
                setCreating(false)
              }}
              placeholder="them@example.com"
            />
          </Field>

          {creating && (
            <>
              <Banner kind="warn">
                <Icon path={icons.warn} size={15} />
                <span>
                  No panel account exists for {email}. Set a password below and one will be created,
                  then granted.
                </span>
              </Banner>
              <Field label="Initial password" hint="At least 8 characters.">
                <input
                  type="text"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="off"
                />
              </Field>
            </>
          )}

          <ErrorText error={formError} />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? (
              <Spinner />
            ) : creating ? (
              "Create account and grant"
            ) : (
              "Grant server administration"
            )}
          </button>
        </form>
      </Card>
    </>
  )
}

/**
 * The per-domain equivalent, rendered as a tab on the domain itself.
 *
 * Granted by the domain's owner rather than by the operator, which is the
 * entire point: adding a mailbox should not have to route through whoever runs
 * the server.
 */
export const DomainAdminsTab = ({ domainId }: { domainId: string }) => {
  const { data, loading, error, reload } = useLoad(
    () => get<{ data: Admin[] }>(`/api/domains/${domainId}/admins`),
    [domainId],
  )
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<unknown>(null)

  const admins = data?.data ?? []

  return (
    <Card title="Domain administrators">
      <p className="muted" style={{ marginTop: 0 }}>
        A domain administrator can add, edit, and remove mailboxes on this domain, and change their
        passwords. They cannot touch its DNS, its billing, or the domain itself — and they cannot
        appoint anybody else here.
      </p>
      <p className="muted">
        Enter a <strong>mailbox on this domain</strong> and they manage it from a Users section
        inside their webmail, with the password they already have — no second login, and they never
        see this panel. Any other address is treated as a panel account, which has to exist already.
      </p>

      {loading ? (
        <Loading />
      ) : error ? (
        <ErrorText error={error} />
      ) : admins.length === 0 ? (
        <Banner>
          <Icon path={icons.account} size={15} />
          <span>No delegates yet — only you can manage this domain's mailboxes.</span>
        </Banner>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Administrator</th>
              <th>Since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {admins.map((admin) => (
              <tr key={admin.user_id ?? admin.address_id}>
                <td>
                  <div>{admin.email}</div>
                  {admin.name && <div className="muted">{admin.name}</div>}
                </td>
                <td className="muted">
                  {admin.subject === "mailbox" ? "Mailbox here" : "Panel account"}
                  {admin.granted_at ? ` · ${new Date(admin.granted_at).toLocaleDateString()}` : ""}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={async () => {
                      await del(
                        `/api/domains/${domainId}/admins/${admin.user_id ?? admin.address_id}`,
                      )
                      reload()
                    }}
                  >
                    Revoke
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form
        style={{ marginTop: 18 }}
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setFormError(null)
          try {
            if (creating) {
              // Signups are closed on a private server, so a delegate has no way
              // to make themselves an account. The owner makes it here, in the
              // same step as the grant — the alternative is a dead end that says
              // "no such account" and offers nothing.
              await post("/api/users", { email, password })
            }
            await post(`/api/domains/${domainId}/admins`, { email })
            setEmail("")
            setPassword("")
            setCreating(false)
            reload()
          } catch (err) {
            // 404 here means the address has no panel account. That is a thing
            // to offer to fix, not an error to report.
            if (!creating && err instanceof RequestError && err.status === 404) {
              setCreating(true)
              setFormError(null)
            } else {
              setFormError(err)
            }
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="Account email"
          hint="A mailbox here, or the sign-in address of an existing panel account."
        >
          <input
            type="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setCreating(false)
            }}
            placeholder="them@yourdomain.com"
          />
        </Field>

        {creating && (
          <>
            <Banner kind="warn">
              <Icon path={icons.warn} size={15} />
              <span>
                No panel account exists for {email}. Set a password below and one will be created,
                then granted. Pass the password on to them — they can change it once they sign in.
              </span>
            </Banner>
            <Field label="Initial password" hint="At least 8 characters.">
              <input
                type="text"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="off"
              />
            </Field>
          </>
        )}

        <ErrorText error={formError} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner /> : creating ? "Create account and grant" : "Add administrator"}
        </button>
      </form>
    </Card>
  )
}
