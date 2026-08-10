import { useState } from "react"
import { navigate } from "../app.tsx"
import {
  Banner,
  Card,
  DataTable,
  ErrorText,
  Field,
  Icon,
  icons,
  Loading,
  Spinner,
  useLoad,
} from "../components/index.tsx"
import { del, get, type Page, patch, post, qs, RequestError } from "../lib/api.ts"

type Filter = {
  id: string
  name: string
  script: string
  size: number
  compile_error: string | null
  updated_at: string
}

const EXAMPLE = `require ["fileinto", "imap4flags"];

# Newsletters go to their own folder rather than the inbox.
if anyof (exists "list-id", header :contains "precedence" "bulk") {
  fileinto :create "Newsletters";
  stop;
}

# Anything from the team is flagged.
if address :domain :is "from" "example.com" {
  addflag "\\\\Flagged";
}
`

export const FiltersPage = () => {
  const [query, setQuery] = useState({
    search: "",
    sort: "name" as string | null,
    direction: "asc" as "asc" | "desc",
    page: 1,
    perPage: 10,
  })

  const { data, error, loading } = useLoad(
    () =>
      get<Page<Filter>>(
        `/api/filters${qs({
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
    <div className="page">
      <ErrorText error={error} />
      <DataTable<Filter>
        columns={[
          {
            key: "name",
            label: "Name",
            sortable: true,
            render: (f) => (
              <>
                <strong>{f.name}</strong>
                {f.compile_error && (
                  <>
                    {" "}
                    <span className="pill pill-bad">error</span>
                  </>
                )}
              </>
            ),
          },
          {
            key: "size",
            label: "Size",
            sortable: true,
            render: (f) => <span className="muted">{f.size} bytes</span>,
          },
        ]}
        page={data}
        loading={loading}
        query={query}
        onQuery={(next) => setQuery((q) => ({ ...q, ...next }))}
        emptyText="Looks like there are no filters yet."
        onRowClick={(f) => navigate(`/filters/${f.id}`)}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => navigate("/filters/new")}
          >
            <Icon path={icons.plus} size={15} /> New filter
          </button>
        }
      />
    </div>
  )
}

export const FilterEditPage = ({ id }: { id: string }) => {
  const isNew = id === "new"
  const { data, loading, error } = useLoad(
    () => (isNew ? Promise.resolve(null) : get<Filter>(`/api/filters/${id}`)),
    [id],
  )

  if (loading) return <Loading />
  if (error) return <ErrorText error={error} />
  return <FilterForm filter={data} />
}

const FilterForm = ({ filter }: { filter: Filter | null }) => {
  const [name, setName] = useState(filter?.name ?? "")
  const [script, setScript] = useState(filter?.script ?? EXAMPLE)
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [validation, setValidation] = useState<{ ok: boolean; error: string | null } | null>(null)

  const gated = error instanceof RequestError && error.needsUpgrade

  const validate = async () => {
    setValidation(
      await post<{ ok: boolean; error: string | null }>("/api/filters/validate", { script }),
    )
  }

  return (
    <div className="page">
      <div className="row">
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => navigate("/filters")}>
          <Icon path={icons.back} size={15} />
        </button>
        <h2 style={{ margin: 0, fontWeight: 650, letterSpacing: "-0.02em" }}>
          {filter ? filter.name : "Create a new filter"}
        </h2>
      </div>

      {gated && (
        <Banner kind="warn">
          <Icon path={icons.warn} size={15} />
          <span>
            Your current plan does not include custom filters.{" "}
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => navigate("/plans")}
            >
              Upgrade your plan
            </button>{" "}
            to save them. You can still write and validate a script here.
          </span>
        </Banner>
      )}

      {filter?.compile_error && (
        <Banner kind="bad">
          <Icon path={icons.warn} size={15} />
          <span>
            This filter failed the last time it ran and is currently being skipped:{" "}
            {filter.compile_error}
          </span>
        </Banner>
      )}

      <Card>
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError(null)
            try {
              if (filter) await patch(`/api/filters/${filter.id}`, { name, script })
              else await post("/api/filters", { name, script })
              navigate("/filters")
            } catch (e) {
              setError(e)
            } finally {
              setBusy(false)
            }
          }}
        >
          <Field label="Name">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my new filter"
            />
          </Field>

          <Field
            label="Script"
            hint={
              <>
                Sieve (RFC 5228). Supported: <span className="mono">if/elsif/else</span>,{" "}
                <span className="mono">fileinto</span>, <span className="mono">redirect</span>,{" "}
                <span className="mono">discard</span>, <span className="mono">reject</span>,{" "}
                <span className="mono">addflag</span>, and the{" "}
                <span className="mono">address / header / envelope / size / exists</span> tests.
              </>
            }
          >
            <textarea
              value={script}
              onChange={(e) => setScript(e.target.value)}
              spellCheck={false}
            />
          </Field>

          {validation && (
            <div style={{ marginBottom: 14 }}>
              <Banner kind={validation.ok ? "good" : "bad"}>
                <Icon path={validation.ok ? icons.check : icons.warn} size={15} />
                <span>{validation.ok ? "The script compiles." : validation.error}</span>
              </Banner>
            </div>
          )}

          {!gated && <ErrorText error={error} />}

          <div className="row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? <Spinner /> : "Save filter"}
            </button>
            <button type="button" className="btn" onClick={validate}>
              Check syntax
            </button>
            {filter && (
              <button
                type="button"
                className="btn btn-danger"
                style={{ marginLeft: "auto" }}
                onClick={async () => {
                  await del(`/api/filters/${filter.id}`)
                  navigate("/filters")
                }}
              >
                <Icon path={icons.trash} size={15} /> Delete
              </button>
            )}
          </div>
        </form>
      </Card>
    </div>
  )
}
