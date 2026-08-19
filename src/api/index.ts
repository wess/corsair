import { withSecurityHeaders } from "@atlas/security"
import { type Route, router } from "@atlas/server"
import { assetResponse, buildClients, type ClientBundle } from "../bundle/index.ts"
import { config } from "../config/index.ts"
import { errorBody, notFound } from "../errors/index.ts"
import webmail from "../mail/index.html"
import panel from "../web/index.html"
import { wrapAll } from "./pipes/index.ts"
import { accountRoutes } from "./routes/account/index.ts"
import { addressRoutes } from "./routes/addresses/index.ts"
import { adminRoutes } from "./routes/admins/index.ts"
import { authRoutes } from "./routes/auth/index.ts"
import { autoconfigRoutes } from "./routes/autoconfig/index.ts"
import { billingRoutes } from "./routes/billing/index.ts"
import { dashboardRoutes } from "./routes/dashboard/index.ts"
import { domainRoutes } from "./routes/domains/index.ts"
import { filterRoutes } from "./routes/filters/index.ts"
import { hookRoutes } from "./routes/hooks/index.ts"
import { jmapRoutes } from "./routes/jmap/index.ts"
import { logRoutes } from "./routes/logs/index.ts"
import { mailAdminRoutes } from "./routes/mailadmin/index.ts"
import { recoveryRoutes } from "./routes/recovery/index.ts"
import { transferRoutes } from "./routes/transfers/index.ts"
import { webhookRoutes } from "./routes/webhooks/index.ts"
import { webmailRoutes } from "./routes/webmail/index.ts"

/**
 * Route order matters: @atlas/server matches in registration order and
 * does not rank static segments above dynamic ones. Anything with a literal
 * segment that could also match a `:param` has to come first — which is why
 * `/api/transfers/destinations` is registered before `/api/transfers/:id`
 * inside its own module, and why `filterRoutes` puts `/api/filters/validate`
 * ahead of `/api/filters/:filter_id`.
 */
export const allRoutes = (): Route[] => [
  ...wrapAll(authRoutes),
  ...wrapAll(accountRoutes),
  ...wrapAll(dashboardRoutes),
  ...wrapAll(logRoutes),
  // Addresses register `/api/domains/:domain_id/addresses`, which must not be
  // shadowed by the domain routes' own `:domain_id` patterns.
  ...wrapAll(addressRoutes),
  // Same reason: `/api/domains/:domain_id/admins` must be registered ahead of
  // the domain routes' own `:domain_id` patterns.
  ...wrapAll(adminRoutes),
  ...wrapAll(domainRoutes),
  ...wrapAll(recoveryRoutes),
  ...wrapAll(hookRoutes),
  ...wrapAll(filterRoutes),
  ...wrapAll(transferRoutes),
  ...wrapAll(billingRoutes),
  ...wrapAll(webhookRoutes),
  // Ahead of the webmail's own routes: `/api/mail/admin/...` must not be
  // shadowed by anything matching `/api/mail/:something`.
  ...wrapAll(mailAdminRoutes),
  ...wrapAll(webmailRoutes),
  ...wrapAll(jmapRoutes),
  ...wrapAll(autoconfigRoutes),
]

const notFoundBody = JSON.stringify(errorBody(notFound("That endpoint does not exist.")))

const SITE_ROOT = new URL("../../site/public/", import.meta.url).pathname

/**
 * Serves the built marketing and documentation site.
 *
 * Only reachable for paths that are not API routes, and only for files that
 * actually resolve inside `site/public` — the normalised path is checked
 * against the root so a `..` in the URL cannot walk out of it.
 */
const serveSite = async (pathname: string): Promise<Response | null> => {
  const relative = pathname.replace(/^\/+/, "") || "index.html"
  const candidate = relative.endsWith("/")
    ? `${relative}index.html`
    : relative.includes(".")
      ? relative
      : `${relative}.html`

  const resolved = new URL(candidate, `file://${SITE_ROOT}`).pathname
  if (!resolved.startsWith(SITE_ROOT)) return null

  const file = Bun.file(resolved)
  if (!(await file.exists())) return null
  return new Response(file)
}

/**
 * The single-page clients and their bundled assets.
 *
 * `/app/*` and `/webmail/*` are client-side routes: every one of them serves
 * the same shell and the router in the browser takes it from there. `/recover`
 * is the panel too — it is reached by people who are not panel users at all, so
 * it lives at the top level rather than under `/app`.
 */
const CLIENT_ROUTES: [RegExp, "panel" | "webmail"][] = [
  [/^\/app(\/.*)?$/, "panel"],
  [/^\/recover(\/.*)?$/, "panel"],
  [/^\/webmail(\/.*)?$/, "webmail"],
]

const serveClient = (clients: ClientBundle, pathname: string, req: Request): Response | null => {
  const chunk = clients.assets.get(pathname)
  if (chunk) return assetResponse(chunk, req)

  for (const [pattern, which] of CLIENT_ROUTES) {
    if (pattern.test(pathname)) return assetResponse(clients[which], req)
  }
  return null
}

export const buildFetch = (clients: ClientBundle | null): ((req: Request) => Promise<Response>) => {
  const handle = router(...allRoutes())
  return async (req: Request): Promise<Response> => {
    const res = await handle(req)
    if (res.status !== 404) return res

    const pathname = new URL(req.url).pathname
    if (!pathname.startsWith("/api/")) {
      // Ahead of the docs site: `/app` must not be answered by an `app.html`
      // that happens to exist under `site/public`.
      if (clients) {
        const client = serveClient(clients, pathname, req)
        if (client) return client
      }

      const site = await serveSite(pathname)
      if (site) return site
    }

    // The router's own 404 is plain text; re-render it in the API envelope so a
    // client only ever has one error shape to parse.
    if ((res.headers.get("content-type") ?? "").startsWith("text/plain")) {
      return new Response(notFoundBody, {
        status: 404,
        headers: { "content-type": "application/json" },
      })
    }
    return res
  }
}

/**
 * `hmr` swaps the ahead-of-time bundle for Bun's `routes` HTMLBundle, which
 * gives the browser hot reload while editing the panel.
 *
 * It is off by default and only `dev.ts` turns it on. That direction matters:
 * `routes` is matched before `fetch`, so an HTMLBundle registered there does
 * not pass through `withSecurityHeaders` and the page comes back with no CSP
 * and no `frame-ancestors`. Opt-in from the development entrypoint means
 * someone running `bun src/start.ts` without NODE_ENV set still gets a
 * hardened panel; opt-out from production would have meant the reverse.
 */
export const startApi = async (port = config.port, options: { hmr?: boolean } = {}) => {
  const clients = options.hmr ? null : await buildClients()

  const fetch = withSecurityHeaders(buildFetch(clients), {
    dev: process.env.NODE_ENV !== "production",
  })

  const server = Bun.serve({
    port,
    hostname: config.host,
    idleTimeout: 60,
    ...(options.hmr
      ? {
          routes: {
            "/app": panel,
            "/app/*": panel,
            "/recover": panel,
            "/webmail": webmail,
            "/webmail/*": webmail,
          },
        }
      : {}),
    fetch,
  })

  console.log(`[corsair] api         http://${config.host}:${server.port}`)
  console.log(`[corsair] panel       http://${config.host}:${server.port}/app`)
  console.log(`[corsair] webmail     http://${config.host}:${server.port}/webmail`)
  return server
}
