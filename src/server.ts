import { startApi } from "./api/index.ts"
import { config } from "./config/index.ts"
import { installCrashGuards } from "./resilience/index.ts"
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

// The web tier serves autoconfig and the MTA-STS policy, both of which name
// what the mail listeners can do — even when those listeners are in another
// process. The answer has to come from the same runtime they run on, so a
// split deployment must run the same Bun version on both tiers.
await probeServerStartTls(await tlsOptions())

await startApi(config.port)
