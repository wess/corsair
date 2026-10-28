import { startApi } from "./api/index.ts"
import { config } from "./config/index.ts"
import { installCrashGuards } from "./resilience/index.ts"
import { assertSecret } from "./secrets/index.ts"
import { probeServerStartTls } from "./starttls/index.ts"
import { tlsOptions } from "./tls/index.ts"

/**
 * The HTTP server on its own: the API, the control panel, the webmail, and
 * JMAP. This is the entrypoint for a deployment that runs the web tier
 * separately from the mail listeners — behind a load balancer, say, where the
 * MX has to live on a fixed IP but the panel does not.
 *
 * `start.ts` runs everything in one process, which is what a single box wants.
 */
installCrashGuards()
assertSecret(config.jwtSecret)

// The web tier serves autoconfig and the MTA-STS policy, both of which name
// what the mail listeners can do — even when those listeners are in another
// process. The answer has to come from the same runtime they run on, so a
// split deployment must run the same Bun version on both tiers.
await probeServerStartTls(await tlsOptions())

// The ACME client lives in start.ts with the listeners it reloads, and its
// challenge tokens live in that process's memory. This tier cannot answer one.
if (config.acme.enabled) {
  console.warn(
    "[corsair] ACME=on has no effect in server.ts: run the mail process with ACME_HTTP_PORT, or use certbot.",
  )
}

await startApi(config.port)
