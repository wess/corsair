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
import { del, formatDate, get, type Page, patch, post } from "../lib/api.ts"

type Agent = {
  id: string
  name: string
  email: string
  domain: string
  can_send: boolean
  token_prefix: string
  last_used_at: string | null
  created_at: string
}

type Domain = { id: string; name: string; status: string }

export const AgentsPage = () => {
  const [creating, setCreating] = useState(false)
  // Set after a create or a rotate: the only moment the token is on screen.
  const [shown, setShown] = useState<{ email: string; token: string } | null>(null)
  const [error, setError] = useState<unknown>(null)

  const agents = useLoad(() => get<{ data: Agent[] }>("/api/agents"))

  const run = async (action: () => Promise<unknown>) => {
    setError(null)
    try {
      await action()
      agents.reload()
    } catch (e) {
      setError(e)
    }
  }

  return (
    <div className="page">
      <Banner>
        <Icon path={icons.agent} size={15} />
        <span>
          An address for an AI agent to sign up for services with, and an API key to read what
          arrives — the confirmation link, the one-time code. The key opens that one mailbox and
          nothing else. Use <span className="mono">name+site@domain</span> to tell signups apart.
        </span>
      </Banner>

      <ErrorText error={agents.error ?? error} />

      <Card
        title="Agents"
        actions={
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => setCreating(true)}
          >
            <Icon path={icons.plus} size={15} /> New agent
          </button>
        }
        bodyless
      >
        <table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Address</th>
              <th>Sending</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {agents.loading && (
              <tr>
                <td colSpan={5} className="empty">
                  <Spinner />
                </td>
              </tr>
            )}
            {!agents.loading && !agents.data?.data.length && (
              <tr>
                <td colSpan={5} className="empty">
                  No agents yet. Create one for each agent that needs an inbox.
                </td>
              </tr>
            )}
            {agents.data?.data.map((agent) => (
              <tr key={agent.id}>
                <td>
                  <strong>{agent.name}</strong>
                  <div className="faint mono">{agent.token_prefix}…</div>
                </td>
                <td className="mono">{agent.email}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm"
                    title="Whether this agent may send mail, capped at 50 recipients a UTC day"
                    onClick={() =>
                      run(() => patch(`/api/agents/${agent.id}`, { can_send: !agent.can_send }))
                    }
                  >
                    {agent.can_send ? <Pill kind="warn">can send</Pill> : <Pill>read only</Pill>}
                  </button>
                </td>
                <td className="muted">
                  {agent.last_used_at ? formatDate(agent.last_used_at) : "never"}
                </td>
                <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      run(async () => {
                        const rotated = await post<{ token: string }>(
                          `/api/agents/${agent.id}/rotate`,
                        )
                        setShown({ email: agent.email, token: rotated.token })
                      })
                    }
                  >
                    <Icon path={icons.refresh} size={14} /> New key
                  </button>{" "}
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => {
                      // Takes the mailbox and its mail with it, so ask.
                      if (
                        window.confirm(
                          `Delete ${agent.email}? Its key stops working and its mail is deleted.`,
                        )
                      ) {
                        run(() => del(`/api/agents/${agent.id}`))
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
      </Card>

      <Card title="Using it">
        <p className="muted" style={{ marginTop: 0 }}>
          Give the agent its address and API key — as a bearer token, or as the username and
          password. Ask for the next message that matches, and it waits for it to arrive:
        </p>
        <pre className="mono">{`curl -H "authorization: Bearer ca_…" \\
  "${window.location.origin}/api/agent/wait?subject=verify&timeout=45"`}</pre>
      </Card>

      {creating && (
        <CreateAgent
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false)
            setShown(created)
            agents.reload()
          }}
        />
      )}

      {shown && (
        <Dialog title="Save the agent's API key" onClose={() => setShown(null)}>
          <Banner kind="warn">
            <Icon path={icons.warn} size={15} />
            <span>
              The key is shown once. A lost key is replaced with a new one, never recovered, and
              replacing it stops the old one at once.
            </span>
          </Banner>
          <div style={{ margin: "16px 0", display: "grid", gap: 12 }}>
            <Field label="Address" hint="The username.">
              <Copyable value={shown.email} />
            </Field>
            <Field
              label="API key"
              hint="The password. Works as a bearer token, as the password in HTTP Basic auth, and as the mailbox password for IMAP, POP3 and SMTP."
            >
              <Copyable value={shown.token} />
            </Field>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => setShown(null)}>
            I have saved it
          </button>
        </Dialog>
      )}
    </div>
  )
}

const CreateAgent = ({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (created: { email: string; token: string }) => void
}) => {
  const [name, setName] = useState("")
  const [domainId, setDomainId] = useState("")
  const [localPart, setLocalPart] = useState("")
  const [canSend, setCanSend] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  const domains = useLoad(() => get<Page<Domain>>("/api/domains?per_page=100"))
  const active = domains.data?.data.filter((d) => d.status === "active") ?? []
  const chosen = domainId || active[0]?.id || ""

  return (
    <Dialog title="New agent" onClose={onClose}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            const created = await post<{ email: string; token: string }>("/api/agents", {
              name,
              domain_id: chosen,
              local_part: localPart.trim() || undefined,
              can_send: canSend,
            })
            onCreated(created)
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Name" hint="Which agent holds it, so you know what stops if you delete it.">
          <input
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="research agent"
          />
        </Field>

        <Field label="Domain" hint="Only domains that have finished DNS setup can receive mail.">
          <select value={chosen} onChange={(e) => setDomainId(e.target.value)}>
            {active.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Address" hint="Leave blank for agent- and eight random characters.">
          <input
            value={localPart}
            onChange={(e) => setLocalPart(e.target.value)}
            placeholder="agent-3f9a1c2e"
          />
        </Field>

        <Field
          label="Sending"
          hint="Off, the agent can only read. On, it can also send, up to 50 recipients a day (UTC). Mail it reads is written by strangers, so leave this off unless it needs to reply."
        >
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="checkbox"
              checked={canSend}
              onChange={(e) => setCanSend(e.target.checked)}
            />
            Let this agent send mail
          </label>
        </Field>

        <ErrorText error={error} />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy || !name.trim() || !chosen}
        >
          {busy ? <Spinner /> : "Create agent"}
        </button>
      </form>
    </Dialog>
  )
}
