import { config } from "../config/index.ts"
import {
  probeServerStartTls,
  setServerStartTlsSupport,
  warnIfStartTlsUnavailable,
} from "../starttls/index.ts"
import { currentTls, replaceTls } from "../tls/index.ts"
import { issueCertificate } from "./client/index.ts"
import { generateKey } from "./jws/index.ts"
import {
  loadAccountKey,
  readCertificate,
  type StoredCertificate,
  writeCertificate,
} from "./store/index.ts"

/**
 * The opt-in ACME client: obtains the mail listeners' certificate over HTTP-01
 * and renews it in place, for an install with no certbot and no reverse proxy.
 *
 * It runs in the all-in-one process (`start.ts`) only, because the challenge
 * tokens live in memory and the listeners it reloads are in that process too.
 */

export type AcmeSettings = {
  directory: string
  email: string
  agreeTos: boolean
  domains: string[]
  dir: string
}

export type IssueTuning = { fetch?: typeof fetch; pollMs?: number; timeoutMs?: number }

const HOUR = 3_600_000
const DAY = 24 * HOUR

/** Let's Encrypt's own advice for 90-day certificates: renew with a third left. */
export const RENEW_DAYS = 30

export const STAGING_DIRECTORY = "https://acme-staging-v02.api.letsencrypt.org/directory"

export const settingsFromConfig = (): AcmeSettings => ({
  directory: config.acme.directory,
  email: config.acme.email,
  agreeTos: config.acme.agreeTos,
  // An empty ACME_DOMAINS= (as in .env.example) means the default, not no names.
  domains: (config.acme.domains.length > 0 ? config.acme.domains : [config.hostname]).map((d) =>
    d.toLowerCase(),
  ),
  dir: config.acme.dir,
})

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/**
 * Both the address and the agreement are required in so many words. A CA's
 * terms are a contract, and agreeing to them on the operator's behalf because a
 * flag defaulted to yes is not something a mail server gets to do.
 */
export const settingsProblems = (s: AcmeSettings): string[] => {
  const problems: string[] = []
  if (!/^[^\s@]+@[^\s@]+$/.test(s.email)) {
    problems.push("ACME_EMAIL must be set to an address the CA can write to about expiry.")
  }
  if (!s.agreeTos) {
    problems.push(
      `ACME_AGREE_TOS=true is required: read the CA's terms (linked from ${s.directory}) first.`,
    )
  }
  if (s.domains.length === 0) problems.push("ACME_DOMAINS lists no names.")
  for (const d of s.domains) {
    if (d.startsWith("*.")) {
      problems.push(`${d}: HTTP-01 cannot issue a wildcard; use certbot with DNS-01 for that.`)
    } else if (!HOSTNAME.test(d)) {
      problems.push(`${d}: not a public hostname a CA will issue for.`)
    }
  }
  return problems
}

/** Why the stored certificate should be replaced, or null if it is fine. */
export const renewalReason = (
  stored: StoredCertificate | null,
  domains: string[],
  now = new Date(),
  days = RENEW_DAYS,
): string | null => {
  if (!stored) return "no certificate yet"
  // ACME_DOMAINS gained a name since the last issue.
  const uncovered = domains.filter((d) => !stored.names.includes(d.toLowerCase()))
  if (uncovered.length > 0) return `it does not cover ${uncovered.join(", ")}`
  const left = stored.notAfter.getTime() - now.getTime()
  if (left <= days * DAY) return `it expires in ${daysLeft(stored, now)} days`
  return null
}

export const daysLeft = (stored: StoredCertificate, now = new Date()): number =>
  Math.max(0, Math.floor((stored.notAfter.getTime() - now.getTime()) / DAY))

/** 1h, 2h, 4h … capped at a day: fast enough to recover inside the 30-day window, slow enough not to hit rate limits. */
export const backoffMs = (failures: number): number =>
  Math.min(HOUR * 2 ** Math.max(0, failures - 1), DAY)

/** Issues and stores a certificate. Does not install it. */
export const obtainCertificate = async (
  s: AcmeSettings,
  tuning: IssueTuning = {},
): Promise<StoredCertificate> => {
  const accountKey = await loadAccountKey(s.dir)
  // A fresh key per certificate: a renewal is the one moment rotating it is free.
  const certKey = generateKey()
  const chain = await issueCertificate({
    directoryUrl: s.directory,
    accountKey,
    certKey,
    email: s.email,
    domains: s.domains,
    ...tuning,
  })
  return writeCertificate(s.dir, certKey, chain)
}

const install = async (stored: StoredCertificate): Promise<void> => {
  const first = !currentTls()
  replaceTls({ cert: stored.chain, key: stored.key })
  if (first) {
    // The startup probe ran without a certificate and so answered no. It has
    // to be asked again now there is something to upgrade to, or STARTTLS
    // stays off until a restart.
    setServerStartTlsSupport(null)
    await probeServerStartTls(currentTls())
    warnIfStartTlsUnavailable()
  }
}

/**
 * One pass: adopt whatever is on disk (a certificate `bun run acme renew` wrote
 * from another process), then renew if it is due. Throws on failure, having
 * changed nothing — the working certificate is only ever replaced by a
 * validated new one.
 */
export const checkCertificate = async (
  s: AcmeSettings,
  tuning: IssueTuning & { now?: Date } = {},
): Promise<{ renewed: boolean; reason: string | null; stored: StoredCertificate | null }> => {
  let stored: StoredCertificate | null = null
  try {
    stored = await readCertificate(s.dir)
  } catch (e) {
    console.error("[corsair] acme: the stored certificate is unusable:", (e as Error).message)
  }
  if (stored && stored.chain !== currentTls()?.cert) await install(stored)

  const reason = renewalReason(stored, s.domains, tuning.now)
  if (!reason) return { renewed: false, reason: null, stored }

  console.log(`[corsair] acme: requesting a certificate for ${s.domains.join(", ")} — ${reason}`)
  const fresh = await obtainCertificate(s, tuning)
  await install(fresh)
  console.log(
    `[corsair] acme: certificate installed for ${fresh.names.join(", ")}, valid until ${fresh.notAfter.toISOString()}`,
  )
  return { renewed: true, reason, stored: fresh }
}

const shout = (
  failures: number,
  error: Error,
  stored: StoredCertificate | null,
  retryMs: number,
) => {
  const lines = [`ACME RENEWAL FAILED (attempt ${failures}): ${error.message}`]
  if (stored) {
    lines.push(
      `  the current certificate stays in service; it expires ${stored.notAfter.toISOString()} (${daysLeft(stored)} days)`,
    )
  } else {
    lines.push(
      "  there is no certificate yet: 465, 993 and 995 stay closed and logins are refused until one is issued",
    )
  }
  lines.push(`  next attempt in ${Math.round(retryMs / 60_000)} minutes`)
  for (const line of lines) console.error(`[corsair] acme: ${line}`)
}

/**
 * The renewal loop: a check now, then daily, with backoff after a failure.
 * Returns a stop function.
 */
export const startAcme = (s: AcmeSettings, tuning: IssueTuning = {}): (() => void) => {
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const schedule = (ms: number) => {
    if (stopped) return
    timer = setTimeout(run, ms)
    timer.unref?.()
  }

  const run = async () => {
    try {
      await checkCertificate(s, tuning)
      failures = 0
      schedule(DAY)
    } catch (e) {
      failures += 1
      const retry = backoffMs(failures)
      const stored = await readCertificate(s.dir).catch(() => null)
      shout(failures, e as Error, stored, retry)
      schedule(retry)
    }
  }

  void run()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

export const acmeStatus = async (s: AcmeSettings) => {
  const stored = await readCertificate(s.dir)
  return {
    directory: s.directory,
    dir: s.dir,
    domains: s.domains,
    problems: settingsProblems(s),
    certificate: stored
      ? { names: stored.names, notAfter: stored.notAfter, daysLeft: daysLeft(stored) }
      : null,
    due: renewalReason(stored, s.domains),
  }
}
