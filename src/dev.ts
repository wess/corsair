import { config } from "./config/index.ts"
import { start } from "./start.ts"

/**
 * The development entrypoint. Same as `start`, plus a reminder of where
 * everything is listening — the ports differ from production because the
 * privileged ones need root or a capability, and nobody should need either to
 * run this locally.
 */
await start()

console.log(`
  panel     ${config.publicUrl}/app
  webmail   ${config.publicUrl}/webmail
  site      ${config.publicUrl}/
  jmap      ${config.publicUrl}/.well-known/jmap

  smtp      ${config.smtp.mxPort} (mx) · ${config.smtp.submissionPort} (submission)
  imap      ${config.imap.port} · ${config.imap.tlsPort} (tls)
  pop3      ${config.pop3.port} · ${config.pop3.tlsPort} (tls)
`)
