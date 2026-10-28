import { startChallengeListener } from "./acme/challenge/index.ts"
import { settingsFromConfig, settingsProblems, startAcme } from "./acme/index.ts"
import { startApi } from "./api/index.ts"
import { config } from "./config/index.ts"
import { startImap } from "./imap/index.ts"
import { startPop3 } from "./pop3/index.ts"
import { installCrashGuards } from "./resilience/index.ts"
import { assertSecret } from "./secrets/index.ts"
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

  // Not in development, where `hmr` is on and a throwaway secret is the point.
  // Everywhere else a default secret is a server whose sessions anyone can forge.
  if (!options.hmr) assertSecret(config.jwtSecret)

  // Refused outright rather than started half-configured: an install that
  // asked for ACME and silently got no certificate finds out in 90 days.
  const acme = config.acme.enabled ? settingsFromConfig() : null
  if (acme) {
    const problems = settingsProblems(acme)
    if (problems.length > 0) throw new Error(`ACME=on but:\n  ${problems.join("\n  ")}`)
  }

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

  // After the listeners, so a first certificate lands on listeners that are
  // already waiting for it. Without one, 465/993/995 open when it arrives and
  // the STARTTLS probe is re-run then.
  if (acme) {
    if (config.acme.httpPort) {
      startChallengeListener(config.acme.httpPort, config.host)
      console.log(`[corsair] acme http   ${config.host}:${config.acme.httpPort}`)
    }
    startAcme(acme)
  }
}

if (import.meta.main) await start()
