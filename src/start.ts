import { startApi } from "./api/index.ts"
import { config } from "./config/index.ts"
import { startImap } from "./imap/index.ts"
import { startPop3 } from "./pop3/index.ts"
import { installCrashGuards } from "./resilience/index.ts"
import { startSmtp } from "./smtp/index.ts"
import { probeServerStartTls } from "./starttls/index.ts"
import { tlsOptions } from "./tls/index.ts"
import { startWorker } from "./worker/index.ts"

/**
 * Everything in one process: the HTTP tier, all the mail listeners, and the
 * worker. The right shape for a single box, and the shape a container wants.
 *
 * Migrations deliberately do NOT run here. Applying them from a serving process
 * means two instances race each other on the way up, and it is the one step
 * worth being able to run — and fail — on its own. See `scripts/migrate.ts`.
 */
export const start = async (options: { hmr?: boolean } = {}): Promise<void> => {
  installCrashGuards()

  // Before anything advertises a capability. Autoconfig names the submission
  // port and MTA-STS names a mode, and both have to agree with what the mail
  // listeners can actually do — a client auto-configured onto a port that
  // refuses it fails silently and forever.
  await probeServerStartTls(await tlsOptions())

  await startApi(config.port, options)
  await startWorker()
  if (config.smtp.enabled) await startSmtp()
  if (config.imap.enabled) await startImap()
  if (config.pop3.enabled) await startPop3()
}

if (import.meta.main) await start()
