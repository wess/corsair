/**
 * Process-level bulkheads.
 *
 * Corsair is one process holding every listener. Without a guard, a single
 * unhandled throw anywhere on the delivery path takes down SMTP, IMAP, POP3,
 * the panel, the webmail, and the worker together — and systemd restarts
 * straight into the same message, so it is a loop rather than a blip.
 *
 * That is not hypothetical. A malformed DKIM key in a sender's DNS made
 * `crypto.verify` throw out of the inbound path and killed the server on
 * ordinary mail. The key was fixed; the shape of the failure was not, and the
 * next unhandled throw in a MIME parser or a Sieve script would do the same.
 *
 * The trade is deliberate. An unhandled rejection means some request or
 * delivery is in an unknown state, and the textbook answer is to exit and let
 * the supervisor restart cleanly. For a mail server that answer is wrong: the
 * blast radius of staying up is one message, and the blast radius of exiting is
 * every connected client plus a queue that stops draining. SMTP is built to
 * retry — the message comes back.
 *
 * What this does NOT do is hide the failure. Everything caught here is logged
 * with its stack, and `corsair_unhandled_total` in the health endpoint counts
 * them so a monitor can alarm on a server that is quietly eating errors.
 */

let unhandled = 0
let installed = false

export const unhandledCount = (): number => unhandled

/**
 * A crash the guard could not usefully absorb still has to end the process.
 * Out of memory is the case that matters: continuing after it produces
 * corrupted work rather than a lost message.
 */
const isFatal = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return /out of memory|heap out of memory|Maximum call stack/i.test(message)
}

const describe = (error: unknown): string => {
  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
  return String(error)
}

export const installCrashGuards = (): void => {
  if (installed) return
  installed = true

  process.on("unhandledRejection", (reason) => {
    unhandled++
    console.error(`[corsair] unhandled rejection (${unhandled} so far):`, describe(reason))
    if (isFatal(reason)) {
      console.error("[corsair] fatal — exiting for a clean restart")
      process.exit(1)
    }
  })

  process.on("uncaughtException", (error) => {
    unhandled++
    console.error(`[corsair] uncaught exception (${unhandled} so far):`, describe(error))
    if (isFatal(error)) {
      console.error("[corsair] fatal — exiting for a clean restart")
      process.exit(1)
    }
  })

  // A peer that disappears mid-write is routine on port 25 and must never be
  // fatal. Bun surfaces it as an unhandled error rather than an event on the
  // socket, which is how it reaches this file at all.
  process.on("SIGPIPE", () => {})
}
