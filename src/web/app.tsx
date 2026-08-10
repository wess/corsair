import { StrictMode, useCallback, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { Icon, icons, Loading } from "./components/index.tsx"
import { get, post } from "./lib/api.ts"
import { AccountPage } from "./pages/account.tsx"
import { AuthPage } from "./pages/auth.tsx"
import { BillingPage, PlansPage } from "./pages/billing.tsx"
import { AddressDetailPage, DomainDetailPage, DomainsPage } from "./pages/domains.tsx"
import { FilterEditPage, FiltersPage } from "./pages/filters.tsx"
import { HookDetailPage, HooksPage } from "./pages/hooks.tsx"
import { OverviewPage } from "./pages/overview.tsx"
import {
  AddressRecoveryPage,
  ForgotPasswordPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from "./pages/recover.tsx"
import { TransfersPage } from "./pages/transfers.tsx"

export const BASE = "/app"

export type Me = {
  object: "user"
  id: string
  email: string
  name: string | null
  notifications_email: string | null
  status: string
  theme: "light" | "dark" | "lights_out"
  totp_enabled: boolean
  is_owner: boolean
  referral_code: string
  notification_prefs: Record<string, boolean>
}

// ------------------------------------------------------------------ router --

export const navigate = (path: string) => {
  window.history.pushState({}, "", `${BASE}${path}`)
  window.dispatchEvent(new PopStateEvent("popstate"))
}

/** The current path, minus the app's base, kept in sync with history. */
const readRoute = (): string => {
  const path = window.location.pathname
  const stripped = path.startsWith(BASE) ? path.slice(BASE.length) : path
  return stripped === "" ? "/" : stripped
}

const useRoute = (): string => {
  const [route, setRoute] = useState(readRoute)
  useEffect(() => {
    const onPop = () => setRoute(readRoute())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])
  return route
}

const NAV = [
  { label: "Overview", path: "/", icon: icons.overview },
  { label: "Domains", path: "/domains", icon: icons.domains },
  { label: "Filters", path: "/filters", icon: icons.filters },
  { label: "Transfers", path: "/transfers", icon: icons.transfers },
  { label: "Webhooks", path: "/webhooks", icon: icons.webhook },
  { label: "Account", path: "/account", icon: icons.account },
  { label: "Plans", path: "/plans", icon: icons.plans },
  { label: "Billing", path: "/billing", icon: icons.billing },
] as const

const titleFor = (route: string): string => {
  if (route.startsWith("/domains")) return "Domains"
  if (route.startsWith("/addresses")) return "Address"
  if (route.startsWith("/filters")) return "Filters"
  if (route.startsWith("/transfers")) return "Transfers"
  if (route.startsWith("/webhooks")) return "Webhooks"
  if (route.startsWith("/account")) return "Account"
  if (route.startsWith("/plans")) return "Plans"
  if (route.startsWith("/billing")) return "Billing"
  return "Overview"
}

const Shell = ({
  me,
  onUpdated,
  onSignOut,
}: {
  me: Me
  onUpdated: (me: Me) => void
  onSignOut: () => void
}) => {
  const route = useRoute()

  const active = [...NAV]
    .sort((a, b) => b.path.length - a.path.length)
    .find((item) => (item.path === "/" ? route === "/" : route.startsWith(item.path)))

  const render = () => {
    if (route === "/" || route === "") return <OverviewPage name={me.name} />

    const domainDetail = route.match(/^\/domains\/([0-9a-f-]{36})/)
    if (domainDetail) return <DomainDetailPage id={domainDetail[1]!} />
    if (route.startsWith("/domains")) return <DomainsPage />

    const addressDetail = route.match(/^\/addresses\/([0-9a-f-]{36})/)
    if (addressDetail) return <AddressDetailPage id={addressDetail[1]!} />

    const filterDetail = route.match(/^\/filters\/([0-9a-f-]{36}|new)/)
    if (filterDetail) return <FilterEditPage id={filterDetail[1]!} />
    if (route.startsWith("/filters")) return <FiltersPage />

    const hookDetail = route.match(/^\/webhooks\/([0-9a-f-]{36})/)
    if (hookDetail) return <HookDetailPage id={hookDetail[1]!} />
    if (route.startsWith("/webhooks")) return <HooksPage />

    if (route.startsWith("/transfers")) return <TransfersPage />
    if (route.startsWith("/account"))
      return <AccountPage me={me} onUpdated={onUpdated} onSignOut={onSignOut} />
    if (route.startsWith("/plans")) return <PlansPage />
    if (route.startsWith("/billing")) return <BillingPage />

    return <OverviewPage name={me.name} />
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">🏴 Corsair</div>

        <nav>
          {NAV.map((item) => (
            <button
              type="button"
              key={item.path}
              className={`nav-item${active?.path === item.path ? " active" : ""}`}
              onClick={() => navigate(item.path)}
            >
              <Icon path={item.icon} />
              {item.label}
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button type="button" className="nav-item" onClick={() => navigate("/account")}>
            <Icon path={icons.account} />
            <span className="truncate">{me.name ?? me.email}</span>
          </button>
          <button type="button" className="nav-item" onClick={onSignOut}>
            <Icon path={icons.logout} />
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>{titleFor(route)}</h1>
          <div className="row">
            <a className="btn btn-sm" href="/docs">
              Docs
            </a>
          </div>
        </header>
        <div className="content">{render()}</div>
      </main>
    </div>
  )
}

const App = () => {
  const [me, setMe] = useState<Me | null>(null)
  const [ready, setReady] = useState(false)
  const [forgot, setForgot] = useState(false)
  const route = useRoute()

  const load = useCallback(() => {
    get<Me>("/api/auth/me")
      .then(setMe)
      .catch(() => setMe(null))
      .finally(() => setReady(true))
  }, [])

  useEffect(load, [load])

  // The theme lives on the account, so it follows a customer between machines
  // rather than being a per-browser setting they have to redo.
  useEffect(() => {
    document.documentElement.dataset.theme = me?.theme ?? "dark"
  }, [me?.theme])

  const signOut = useCallback(async () => {
    await post("/api/auth/logout").catch(() => {})
    setMe(null)
    navigate("/")
  }, [])

  if (!ready) return <Loading />

  // These render before the sign-in gate: somebody who has lost their password
  // cannot sign in to reach them.
  const params = new URLSearchParams(window.location.search)
  if (route.startsWith("/reset")) {
    return <ResetPasswordPage token={params.get("token") ?? ""} onDone={() => navigate("/")} />
  }
  if (route.startsWith("/verify")) {
    return (
      <VerifyEmailPage
        token={params.get("token") ?? ""}
        onDone={() => {
          load()
          navigate("/")
        }}
      />
    )
  }
  if (route.startsWith("/recover")) return <AddressRecoveryPage />
  if (!me && forgot) return <ForgotPasswordPage onBack={() => setForgot(false)} />

  if (!me) return <AuthPage onAuthenticated={setMe} onForgot={() => setForgot(true)} />
  return <Shell me={me} onUpdated={setMe} onSignOut={signOut} />
}

const root = document.getElementById("root")
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
