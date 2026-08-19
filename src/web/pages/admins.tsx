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
import { del, get, post } from "../lib/api.ts"

/**
 * Who else may act on this server.
 *
 * The owner's screen. Domain-level delegation lives on the domain itself, where
 * the person granting it already is — this page is only for the grant that
 * crosses every account.
 */

type Admin = {
  user_id: string
  email: string
  name: string | null
  status: string
  is_owner: boolean
  is_admin: boolean
  granted_at: string | null
}

export const AdminsPage = () => {
  const { data, loading, error, reload } = useLoad(() => get<{ data: Admin[] }>("/api/admins"))
  const [email, setEmail] = useState("")
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
              await post("/api/admins", { email })
              setEmail("")
              reload()
            } catch (err) {
              setFormError(err)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field
            label="Account email"
            hint="They need a panel account on this server already. This is their sign-in address, not a mailbox."
          >
            <input
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="them@example.com"
            />
          </Field>
          <ErrorText error={formError} />
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? <Spinner /> : "Grant server administration"}
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
              <th>Account</th>
              <th>Since</th>
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
                <td className="muted">
                  {admin.granted_at ? new Date(admin.granted_at).toLocaleDateString() : "—"}
                </td>
                <td style={{ textAlign: "right" }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={async () => {
                      await del(`/api/domains/${domainId}/admins/${admin.user_id}`)
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
            await post(`/api/domains/${domainId}/admins`, { email })
            setEmail("")
            reload()
          } catch (err) {
            setFormError(err)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field
          label="Account email"
          hint="They need a panel account on this server already. This is their sign-in address, not a mailbox."
        >
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="them@example.com"
          />
        </Field>
        <ErrorText error={formError} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner /> : "Add administrator"}
        </button>
      </form>
    </Card>
  )
}
