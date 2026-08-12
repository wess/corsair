import type { TlsMaterial } from "../tls/index.ts"
import { config } from "../config/index.ts"

/**
 * Whether this runtime can upgrade an *accepted* socket to TLS in place.
 *
 * This matters far more than it looks. Advertising STARTTLS and then failing
 * the handshake is **worse than never advertising it**: a sending server sees
 * the capability, issues the command, and gets its connection dropped
 * mid-handshake. It cannot fall back — it has already committed — so it defers
 * and retries into the same wall until the message bounces days later. Every
 * major provider uses opportunistic STARTTLS on port 25, so advertising a
 * broken one means silently receiving no mail from any of them.
 *
 * Given the choice between "unencrypted" and "lost", a mail server must choose
 * unencrypted.
 *
 * ## Why this is a probe and not a version check
 *
 * The capability arrived without a feature flag to test. `socket.upgradeTLS`
 * has existed for a long time as a *client* API and is a function on every
 * version, so `typeof` proves nothing; it throws "Server-side upgradeTLS is not
 * supported" at call time on a socket that came from `Bun.listen`. An earlier
 * version of this file tested for `Bun.upgradeDuplexToTLS`, which the error
 * message names but which does not exist on any build — so it would have kept
 * STARTTLS switched off even after the runtime learned how to do it.
 *
 * The only honest test is to do it: open a listener on loopback, connect to it,
 * and try. It costs a few milliseconds once at startup and it cannot be wrong
 * about the runtime it is running on.
 *
 * Implicit TLS is unaffected either way — `Bun.listen({ tls })` is encrypted
 * from the first byte and needs no upgrade, which is why 465, 993, and 995 have
 * always worked and are what clients should be pointed at until this returns
 * true.
 */

let supported: boolean | null = null

/** The probe's answer. False until `probeServerStartTls` has run and succeeded. */
export const canUpgradeServerSocketToTls = (): boolean => supported === true

/**
 * Whether STARTTLS is offered *by this server as the world sees it*.
 *
 * Not the same question as whether this runtime can perform the upgrade. Ports
 * 25 and 587 are held by the terminator in `engine/`, which does the upgrade
 * Bun cannot and relays to loopback listeners that never see a handshake — so
 * the probe says no while the internet is served STARTTLS on both ports.
 *
 * The listeners keep asking the probe, because it answers what *they* can do.
 * Everything that describes the server to somebody else — autoconfig, the MTA-STS
 * policy, the dashboard — asks this instead, or it would publish `mode: none`
 * and steer clients away from a port that works.
 */
export const startTlsOffered = (): boolean =>
  canUpgradeServerSocketToTls() || config.smtp.startTlsFronted

/** Test seam: force the answer without opening a socket. */
export const setServerStartTlsSupport = (value: boolean | null): void => {
  supported = value
}

const attempt = (tls: TlsMaterial): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false
    let listener: { stop: (closeActive?: boolean) => void } | null = null

    const done = (value: boolean) => {
      if (settled) return
      settled = true
      try {
        listener?.stop(true)
      } catch {
        // The listener is being torn down either way.
      }
      resolve(value)
    }

    try {
      listener = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: {
          open(socket) {
            try {
              ;(socket as unknown as { upgradeTLS: (options: unknown) => unknown }).upgradeTLS({
                isServer: true,
                tls,
                socket: {
                  handshake(_s: unknown, success: boolean) {
                    done(success)
                  },
                  data() {},
                  open() {},
                  drain() {},
                  error() {
                    done(false)
                  },
                  close() {},
                },
              })
            } catch {
              // "Server-side upgradeTLS is not supported" — the answer is no.
              done(false)
            }
          },
          data() {},
          error() {
            done(false)
          },
          close() {},
        },
      }) as unknown as { stop: (closeActive?: boolean) => void; port: number }

      void Bun.connect({
        hostname: "127.0.0.1",
        port: (listener as unknown as { port: number }).port,
        tls: { rejectUnauthorized: false },
        socket: {
          data() {},
          open() {},
          error() {
            done(false)
          },
          close() {},
        },
      }).catch(() => done(false))
    } catch {
      done(false)
    }

    // A hung handshake is a no. Unref'd so it never holds the process open.
    setTimeout(() => done(false), 5_000).unref?.()
  })

/**
 * Runs the probe once and caches the answer. Safe to call from more than one
 * entrypoint; the second call is free.
 *
 * Without a certificate there is nothing to upgrade *to*, so the answer is no
 * regardless of what the runtime supports.
 */
export const probeServerStartTls = async (tls: TlsMaterial | null): Promise<boolean> => {
  if (supported !== null) return supported
  supported = tls ? await attempt(tls) : false
  return supported
}

/**
 * Upgrades an accepted socket to TLS and returns Bun's `[raw, tls]` pair.
 *
 * The cast is here rather than at each of the three listeners because
 * `bun-types` does not yet describe `isServer` on `TLSUpgradeOptions`, and one
 * explained cast is better than three unexplained ones. Drop it when the types
 * catch up.
 *
 * The caller must record the returned TLS socket and ignore anything that
 * still arrives on the original: Bun delivers the post-upgrade stream to both
 * (oven-sh/bun#26297).
 */
export const upgradeAcceptedSocket = <T>(
  socket: Bun.Socket<T>,
  options: { tls: TlsMaterial; socket: unknown },
): [unknown, Bun.Socket<T>] =>
  (socket as unknown as { upgradeTLS: (o: unknown) => unknown }).upgradeTLS({
    isServer: true,
    tls: options.tls,
    socket: options.socket,
  }) as [unknown, Bun.Socket<T>]

/** One line at startup, so an operator is not left guessing why 587 refuses AUTH. */
export const warnIfStartTlsUnavailable = (): void => {
  if (canUpgradeServerSocketToTls()) return
  console.warn(
    "[corsair] STARTTLS is unavailable on this runtime (it cannot upgrade an accepted socket).\n" +
      "[corsair]   It is deliberately not advertised: advertising and failing loses mail outright.\n" +
      "[corsair]   Clients are pointed at the implicit-TLS ports — SMTP 465, IMAP 993, POP3 995.\n" +
      "[corsair]   Port 25 still accepts mail, unencrypted, which is what senders fall back to.",
  )
}
