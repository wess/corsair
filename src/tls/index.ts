import { config } from "../config/index.ts"

export type TlsMaterial = { cert: string; key: string }

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
 */
export const tlsOptions = async (): Promise<TlsMaterial | null> => {
  if (!config.tls.certPath || !config.tls.keyPath) return null
  try {
    const [cert, key] = await Promise.all([
      Bun.file(config.tls.certPath).text(),
      Bun.file(config.tls.keyPath).text(),
    ])
    return { cert, key }
  } catch (e) {
    console.error("[corsair] could not read the TLS certificate:", (e as Error).message)
    return null
  }
}
