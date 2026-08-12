import { useState } from "react"
import { navigate } from "../app.tsx"
import {
  Banner,
  Card,
  DataTable,
  Dialog,
  ErrorText,
  Field,
  Icon,
  icons,
  Loading,
  Pill,
  Spinner,
  useLoad,
} from "../components/index.tsx"
import {
  del,
  formatBytes,
  formatDate,
  formatMoney,
  get,
  type Page,
  post,
  put,
  qs,
} from "../lib/api.ts"

type Plan = {
  id: string
  key: string
  name: string
  storage_bytes: number
  daily_in: number
  daily_out: number
  monthly_cents: number
  yearly_cents: number
  features: Record<string, boolean>
  is_trial: boolean
}

// ------------------------------------------------------------------ plans --

export const PlansPage = () => {
  const [interval, setInterval] = useState<"monthly" | "yearly">("yearly")
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)

  const { data, loading, reload } = useLoad(() =>
    get<{ data: Plan[]; current_plan_id: string | null; owner: boolean; beta?: boolean }>(
      "/api/plans",
    ),
  )

  if (loading) return <Loading />

  const choose = async (plan: Plan) => {
    setBusy(plan.id)
    setError(null)
    try {
      await post("/api/subscription", { plan_id: plan.id, interval })
      reload()
    } catch (e) {
      setError(e)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="page">
      <div className="row spread">
        <h2 style={{ margin: 0, fontWeight: 650, letterSpacing: "-0.02em" }}>Plan selection</h2>
        <div className="segmented">
          {(["monthly", "yearly"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={interval === value ? "active" : ""}
              onClick={() => setInterval(value)}
            >
              {value === "monthly" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
      </div>

      <ErrorText error={error} />

      <div className="grid grid-3">
        {data?.data.map((plan) => {
          const active = plan.id === data.current_plan_id
          // The owner is not a customer of their own server: nothing to buy,
          // nothing to cancel.
          const owner = data.owner === true
          const price = interval === "monthly" ? plan.monthly_cents : plan.yearly_cents
          return (
            <button
              key={plan.id}
              type="button"
              className={`plan-card${active ? " active" : ""}`}
              onClick={() => !active && !owner && choose(plan)}
              disabled={busy !== null || owner}
            >
              {active && (
                <div style={{ marginBottom: 8 }}>
                  <Pill kind="good">{owner ? "Owner" : "Active"}</Pill>
                </div>
              )}
              <h3>{plan.name}</h3>
              <div className="stat">{formatBytes(plan.storage_bytes)}</div>
              <div className="stat-label" style={{ marginTop: 6 }}>
                <strong>{plan.daily_in || "∞"}</strong> in /{" "}
                <strong>{plan.daily_out || "∞"}</strong> out per day
              </div>
              <div style={{ marginTop: 12, fontWeight: 650 }}>
                {price === 0
                  ? "Free"
                  : `${formatMoney(price)} / ${interval === "monthly" ? "mo" : "yr"}`}
              </div>
              <div className="hint" style={{ marginTop: 10, textAlign: "left" }}>
                {Object.entries(plan.features)
                  .filter(([, on]) => on)
                  .map(([key]) => (
                    <div key={key}>· {key.replace(/_/g, " ")}</div>
                  ))}
              </div>
              {busy === plan.id && <Spinner />}
            </button>
          )
        })}
      </div>

      {data?.owner ? (
        <p className="muted" style={{ textAlign: "center" }}>
          You own this server, so every feature is on and there is nothing to pay. Plans apply to
          the accounts you host on it.
        </p>
      ) : data?.beta ? (
        <p className="muted" style={{ textAlign: "center" }}>
          Free during the beta. Prices are what these plans will cost later — nothing is charged
          now, and no card is needed to switch between them.
        </p>
      ) : (
        <div style={{ textAlign: "center" }}>
          <button type="button" className="btn btn-danger" onClick={() => setCancelling(true)}>
            Cancel subscription
          </button>
        </div>
      )}

      {cancelling && (
        <Dialog title="Cancel subscription" onClose={() => setCancelling(false)}>
          <p>
            Your mail keeps working until the end of the period you have already paid for. After
            that the account drops to the trial plan.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn btn-danger"
              onClick={async () => {
                await post("/api/subscription/cancel")
                setCancelling(false)
                reload()
              }}
            >
              Cancel at period end
            </button>
            <button type="button" className="btn" onClick={() => setCancelling(false)}>
              Keep my plan
            </button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- billing --

const TABS = [
  { key: "history", label: "History" },
  { key: "methods", label: "Payment methods" },
  { key: "tax", label: "Tax ID" },
] as const

export const BillingPage = () => {
  const [tab, setTab] = useState<string>("history")
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
      {tab === "history" && <History />}
      {tab === "methods" && <PaymentMethods />}
      {tab === "tax" && <TaxId />}
    </div>
  )
}

type Transaction = {
  id: string
  description: string
  amount_cents: number
  currency: string
  status: string
  transaction_date: string
}

const History = () => {
  const [selected, setSelected] = useState<Transaction | null>(null)
  const [query, setQuery] = useState({
    search: "",
    sort: "date" as string | null,
    direction: "desc" as "asc" | "desc",
    page: 1,
    perPage: 10,
  })

  const { data, loading, error } = useLoad(
    () =>
      get<Page<Transaction>>(
        `/api/billing/transactions${qs({
          search: query.search,
          sort: query.sort,
          direction: query.direction,
          page: query.page,
          per_page: query.perPage,
        })}`,
      ),
    [query.search, query.sort, query.direction, query.page, query.perPage],
  )

  return (
    <>
      <ErrorText error={error} />
      <DataTable<Transaction>
        columns={[
          {
            key: "description",
            label: "Description",
            sortable: true,
            render: (t) => t.description,
          },
          {
            key: "amount",
            label: "Amount",
            sortable: true,
            render: (t) => formatMoney(t.amount_cents, t.currency),
          },
          {
            key: "status",
            label: "Status",
            render: (t) => <Pill kind={t.status === "paid" ? "good" : "warn"}>{t.status}</Pill>,
          },
          {
            key: "date",
            label: "Transaction date",
            sortable: true,
            render: (t) => <span className="muted">{formatDate(t.transaction_date)}</span>,
          },
        ]}
        page={data}
        loading={loading}
        query={query}
        onQuery={(next) => setQuery((q) => ({ ...q, ...next }))}
        emptyText="No transactions yet."
        onRowClick={setSelected}
      />

      {selected && <TransactionDetail transaction={selected} onClose={() => setSelected(null)} />}
    </>
  )
}

/** The receipt Mango shows at /dashboard/billing/transaction. */
const TransactionDetail = ({
  transaction,
  onClose,
}: {
  transaction: Transaction
  onClose: () => void
}) => {
  const taxId = useLoad(() =>
    get<{ id: string | null; kind?: string; value?: string; business_name?: string | null }>(
      "/api/billing/tax-id",
    ),
  )

  const rows: [string, string][] = [
    ["Description", transaction.description],
    ["Amount", formatMoney(transaction.amount_cents, transaction.currency)],
    ["Status", transaction.status],
    ["Date", formatDate(transaction.transaction_date)],
    ["Reference", transaction.id],
  ]
  if (taxId.data?.id) {
    rows.push([`${taxId.data.kind ?? "Tax"} ID`, taxId.data.value ?? ""])
    if (taxId.data.business_name) rows.push(["Business", taxId.data.business_name])
  }

  return (
    <Dialog title="Transaction" onClose={onClose}>
      {rows.map(([label, value]) => (
        <div key={label} className="row spread" style={{ padding: "7px 0" }}>
          <span className="muted">{label}</span>
          <span className={label === "Reference" ? "mono truncate" : ""}>{value}</span>
        </div>
      ))}
      <div style={{ marginTop: 16 }}>
        <button type="button" className="btn" onClick={() => window.print()}>
          Print receipt
        </button>
      </div>
    </Dialog>
  )
}

type PaymentMethod = {
  id: string
  brand: string
  last4: string
  exp_month: number | null
  exp_year: number | null
  is_default: boolean
}

const PaymentMethods = () => {
  const { data, loading, error, reload } = useLoad(() =>
    get<{ data: PaymentMethod[] }>("/api/billing/payment-methods"),
  )
  const provider = useLoad(() =>
    get<{ configured: boolean; beta?: boolean }>("/api/billing/provider"),
  )
  const [adding, setAdding] = useState(false)

  if (loading) return <Loading />

  // Nothing is being charged, so inviting someone to add a card sends them
  // looking for a provider this server has not got.
  const beta = provider.data?.beta === true

  return (
    <>
      <ErrorText error={error} />
      <Card
        title="Payment methods"
        actions={
          beta ? null : (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => setAdding(true)}
            >
              <Icon path={icons.plus} size={14} /> Add
            </button>
          )
        }
        bodyless
      >
        {beta && (
          <p className="hint" style={{ padding: "12px 16px", margin: 0 }}>
            Not needed during the beta — nothing is charged. You can add one when billing opens.
          </p>
        )}
        <table>
          <thead>
            <tr>
              <th>Card</th>
              <th>Expires</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {!data?.data.length && (
              <tr>
                <td colSpan={3} className="empty">
                  No payment method on file.
                </td>
              </tr>
            )}
            {data?.data.map((method) => (
              <tr key={method.id}>
                <td>
                  <strong>{method.brand}</strong>{" "}
                  <span className="mono muted">•••• {method.last4}</span>
                  {method.is_default && (
                    <>
                      {" "}
                      <Pill kind="good">default</Pill>
                    </>
                  )}
                </td>
                <td className="muted">
                  {method.exp_month && method.exp_year
                    ? `${String(method.exp_month).padStart(2, "0")}/${method.exp_year}`
                    : "—"}
                </td>
                <td>
                  <div className="row" style={{ justifyContent: "flex-end" }}>
                    {!method.is_default && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={async () => {
                          await post(`/api/billing/payment-methods/${method.id}/default`)
                          reload()
                        }}
                      >
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      onClick={async () => {
                        await del(`/api/billing/payment-methods/${method.id}`)
                        reload()
                      }}
                    >
                      Remove
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {adding && (
        <AddPaymentMethod
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false)
            reload()
          }}
        />
      )}
    </>
  )
}

const AddPaymentMethod = ({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) => {
  const [brand, setBrand] = useState("Visa")
  const [last4, setLast4] = useState("")
  const [ref, setRef] = useState("")
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)

  return (
    <Dialog title="Add a payment method" onClose={onClose}>
      <Banner kind="info">
        <Icon path={icons.warn} size={15} />
        <span>
          Card details never reach this server. Tokenise the card with your payment provider and
          record the token here — this form deliberately has no field for a card number.
        </span>
      </Banner>
      <div style={{ height: 16 }} />

      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          setError(null)
          try {
            await post("/api/billing/payment-methods", {
              provider: "manual",
              provider_ref: ref,
              brand,
              last4,
            })
            onAdded()
          } catch (e) {
            setError(e)
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Brand">
          <input required value={brand} onChange={(e) => setBrand(e.target.value)} />
        </Field>
        <Field label="Last four digits">
          <input
            required
            maxLength={4}
            minLength={4}
            value={last4}
            onChange={(e) => setLast4(e.target.value.replace(/\D/g, ""))}
          />
        </Field>
        <Field label="Provider token" hint="The reference your payment provider returned.">
          <input required value={ref} onChange={(e) => setRef(e.target.value)} />
        </Field>
        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? <Spinner /> : "Add payment method"}
        </button>
      </form>
    </Dialog>
  )
}

const TaxId = () => {
  const { data, loading, error, reload } = useLoad(() =>
    get<{
      id: string | null
      kind?: string
      value?: string
      country?: string | null
      business_name?: string | null
      address_line?: string | null
    }>("/api/billing/tax-id"),
  )
  const [saved, setSaved] = useState(false)

  if (loading) return <Loading />

  return (
    <Card title="Tax ID">
      <p className="muted" style={{ marginTop: 0 }}>
        Added to every invoice. Leave it empty if you do not need one.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          const form = new FormData(e.currentTarget)
          await put("/api/billing/tax-id", {
            kind: String(form.get("kind") ?? ""),
            value: String(form.get("value") ?? ""),
            country: String(form.get("country") ?? "") || null,
            business_name: String(form.get("business_name") ?? "") || null,
            address_line: String(form.get("address_line") ?? "") || null,
          })
          setSaved(true)
          reload()
        }}
      >
        <div className="grid grid-2">
          <Field label="Type">
            <input name="kind" defaultValue={data?.kind ?? "VAT"} required />
          </Field>
          <Field label="Number">
            <input name="value" defaultValue={data?.value ?? ""} required />
          </Field>
        </div>
        <Field label="Business name">
          <input name="business_name" defaultValue={data?.business_name ?? ""} />
        </Field>
        <div className="grid grid-2">
          <Field label="Address">
            <input name="address_line" defaultValue={data?.address_line ?? ""} />
          </Field>
          <Field label="Country code">
            <input name="country" maxLength={2} defaultValue={data?.country ?? ""} />
          </Field>
        </div>
        {saved && (
          <div style={{ marginBottom: 14 }}>
            <Banner kind="good">
              <Icon path={icons.check} size={15} />
              <span>Saved.</span>
            </Banner>
          </div>
        )}
        <ErrorText error={error} />
        <button type="submit" className="btn btn-primary">
          Save tax ID
        </button>
      </form>
    </Card>
  )
}

export const goToPlans = () => navigate("/plans")
