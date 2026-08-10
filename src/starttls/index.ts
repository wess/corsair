/**
 * Whether this runtime can upgrade an *accepted* socket to TLS in place.
 *
 * Bun's `socket.upgradeTLS()` is a client-side API. On a socket that came from
 * `Bun.listen` it throws:
 *
 *   Server-side upgradeTLS is not supported.
 *   Use upgradeDuplexToTLS with isServer: true instead.
 *
 * and `Bun.upgradeDuplexToTLS` does not exist as of Bun 1.3.14, so there is no
 * server-side STARTTLS path at all right now.
 *
 * This matters far more than it looks. Advertising STARTTLS and then failing the
 * handshake is **worse than never advertising it**: a sending server sees the
 * capability, issues the command, and gets its connection dropped mid-handshake.
 * It cannot fall back — it has already committed — so it defers and retries into
 * the same wall until the message bounces days later. Every major provider uses
 * opportunistic STARTTLS on port 25, so advertising a broken one means silently
 * receiving no mail from any of them.
 *
 * Not advertising it means those senders deliver in plaintext instead, which is
 * worse for privacy but is *delivery*. Given the choice between "unencrypted" and
 * "lost", mail servers must choose unencrypted.
 *
 * Implicit TLS is unaffected — `Bun.listen({ tls })` is encrypted from the first
 * byte and needs no upgrade. Ports 465, 993, and 995 work correctly, and are what
 * clients should be pointed at.
 *
 * When Bun grows a server-side upgrade, implement it in the three `data()`
 * handlers and make this return true; the `startTls` plumbing in each listener is
 * already wired and gated on this one value.
 */
export const canUpgradeServerSocketToTls = (): boolean => {
  const bun = globalThis as { Bun?: { upgradeDuplexToTLS?: unknown } }
  return typeof bun.Bun?.upgradeDuplexToTLS === "function"
}

/** One line at startup, so an operator is not left guessing why 587 refuses AUTH. */
export const warnIfStartTlsUnavailable = (): void => {
  if (canUpgradeServerSocketToTls()) return
  console.warn(
    "[corsair] STARTTLS is unavailable on this runtime (Bun cannot upgrade an accepted socket).\n" +
      "[corsair]   It is deliberately not advertised: advertising and failing loses mail outright.\n" +
      "[corsair]   Point clients at the implicit-TLS ports — SMTP 465, IMAP 993, POP3 995.\n" +
      "[corsair]   Port 25 still accepts mail, unencrypted, which is what senders fall back to.",
  )
}
