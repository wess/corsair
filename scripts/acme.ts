import { startChallengeListener } from "../src/acme/challenge/index.ts"
import {
  acmeStatus,
  obtainCertificate,
  renewalReason,
  settingsFromConfig,
  settingsProblems,
} from "../src/acme/index.ts"
import { readCertificate } from "../src/acme/store/index.ts"
import { config } from "../src/config/index.ts"

/**
 * bun scripts/acme.ts status        what is stored, when it expires, whether it is due
 * bun scripts/acme.ts renew [--force]
 *
 * `renew` answers the challenge itself on ACME_HTTP_PORT, so that port must be
 * free — which it is not while the server holds it. With the server running,
 * leave renewal to it; this is for a first certificate before starting, or for
 * recovering by hand. A running server adopts what this writes at its next
 * daily check, or at restart.
 */

const settings = settingsFromConfig()
const [command, flag] = process.argv.slice(2)

const status = async () => {
  const s = await acmeStatus(settings)
  console.log(`ACME        ${config.acme.enabled ? "on" : "off"}`)
  console.log(`directory   ${s.directory}`)
  console.log(`storage     ${s.dir}`)
  console.log(`domains     ${s.domains.join(", ")}`)
  if (s.certificate) {
    console.log(`certificate ${s.certificate.names.join(", ")}`)
    console.log(
      `expires     ${s.certificate.notAfter.toISOString()} (${s.certificate.daysLeft} days)`,
    )
  } else {
    console.log("certificate none")
  }
  console.log(`renewal     ${s.due ? `due: ${s.due}` : "not due"}`)
  for (const p of s.problems) console.log(`problem     ${p}`)
}

const renew = async () => {
  const problems = settingsProblems(settings)
  if (problems.length > 0) {
    for (const p of problems) console.error(p)
    process.exit(1)
  }
  if (flag !== "--force") {
    const reason = renewalReason(await readCertificate(settings.dir), settings.domains)
    if (!reason) {
      console.log("Not due. Pass --force to renew anyway.")
      return
    }
  }
  if (!config.acme.httpPort) {
    console.error(
      "renew needs ACME_HTTP_PORT: the challenge has to be answered by this process. " +
        "A running server renews on its own.",
    )
    process.exit(1)
  }
  const listener = startChallengeListener(config.acme.httpPort, config.host)
  try {
    const stored = await obtainCertificate(settings)
    console.log(
      `issued for ${stored.names.join(", ")}, valid until ${stored.notAfter.toISOString()}`,
    )
  } finally {
    listener.stop(true)
  }
}

if (command === "status") await status()
else if (command === "renew") await renew()
else {
  console.error("usage: bun scripts/acme.ts status | renew [--force]")
  process.exit(1)
}
