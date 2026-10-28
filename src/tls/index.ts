import { readCertificate } from "../acme/store/index.ts"
import { config } from "../config/index.ts"

export type TlsMaterial = { cert: string; key: string }

let current: TlsMaterial | null = null
const watchers = new Set<(tls: TlsMaterial) => void>()

/**
 * The certificate the mail listeners present.
 *
 * One copy, read by SMTP, IMAP, POP3, and the STARTTLS capability probe. It
 * used to be three byte-identical copies, which is the kind of duplication that
 * stays correct right up until one of them is changed.
 *
 * Returns null rather than throwing when nothing is configured: an install
 * without a certificate still serves the panel and still accepts mail on port
 * 25. It just cannot offer AUTH or any of the TLS ports, and each listener says
 * so at startup.
 *
 * With `ACME=on` the paths are ignored and the certificate comes from
 * `ACME_DIR`, which may not hold one yet on a first start.
 */
export const tlsOptions = async (): Promise<TlsMaterial | null> => {
  if (config.acme.enabled) {
    try {
      const stored = await readCertificate(config.acme.dir)
      if (stored) current = { cert: stored.chain, key: stored.key }
      return stored ? current : null
    } catch (e) {
      console.error("[corsair] could not read the ACME certificate:", (e as Error).message)
      return null
    }
  }
  if (!config.tls.certPath || !config.tls.keyPath) return null
  try {
    const [cert, key] = await Promise.all([
      Bun.file(config.tls.certPath).text(),
      Bun.file(config.tls.keyPath).text(),
    ])
    current = { cert, key }
    return current
  } catch (e) {
    console.error("[corsair] could not read the TLS certificate:", (e as Error).message)
    return null
  }
}

/**
 * What a listener should present *now*. STARTTLS reads this at the moment of
 * each upgrade, which is all hot reload takes for 25, 587, 143 and 110.
 */
export const currentTls = (): TlsMaterial | null => current

/** Installs a new certificate and tells every implicit-TLS listener. */
export const replaceTls = (tls: TlsMaterial): void => {
  current = tls
  for (const fn of watchers) fn(tls)
}

type Listener = { stop: (closeActive?: boolean) => void }

/**
 * Runs an implicit-TLS listener (465, 993, 995) that follows `replaceTls`.
 *
 * Neither `listener.reload` nor `server.reload({ tls })` changes the
 * certificate on Bun 1.4 — both accept the option and keep serving the old one,
 * verified with a handshake. So a new certificate means a new listener: the old
 * one stops accepting (`stop(false)` leaves its open sessions alone, so an IMAP
 * IDLE survives a renewal) and a fresh one binds the same port.
 *
 * With no certificate yet nothing listens, and the first `replaceTls` starts it.
 */
export const serveImplicitTls = (
  label: string,
  make: (tls: TlsMaterial) => Listener,
): (() => void) => {
  let listener: Listener | null = current ? make(current) : null
  let serving: TlsMaterial | null = current
  const watcher = (tls: TlsMaterial) => {
    listener?.stop(false)
    listener = null
    try {
      listener = make(tls)
      serving = tls
      console.log(`[corsair] ${label}: now serving the new certificate`)
    } catch (e) {
      console.error(
        `[corsair] ${label}: could not rebind with the new certificate:`,
        (e as Error).message,
      )
      // Put the old one back rather than leave the port closed.
      try {
        listener = serving ? make(serving) : null
      } catch {
        console.error(`[corsair] ${label}: PORT CLOSED — restart Corsair to bring it back`)
      }
    }
  }
  watchers.add(watcher)
  return () => {
    watchers.delete(watcher)
    listener?.stop(true)
  }
}
