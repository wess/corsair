import { startApi } from "./api/index.ts"
import { config } from "./config/index.ts"

/**
 * The HTTP server on its own: the API, the control panel, the webmail, and
 * JMAP. This is the entrypoint for a deployment that runs the web tier
 * separately from the mail listeners — behind a load balancer, say, where the
 * MX has to live on a fixed IP but the panel does not.
 *
 * `start.ts` runs everything in one process, which is what a single box wants.
 */
startApi(config.port)
