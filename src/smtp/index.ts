import { clearAuthFailures, isBanned, recordAuthFailure } from "../auth/index.ts"
import { config } from "../config/index.ts"
import {
  canUpgradeServerSocketToTls,
  upgradeAcceptedSocket,
  warnIfStartTlsUnavailable,
} from "../starttls/index.ts"
import { tlsOptions } from "../tls/index.ts"
import * as inbound from "./inbound/index.ts"
import { isLoopback } from "./inbound/index.ts"
import { createSession, type Identity, type Session, type SessionMode } from "./session/index.ts"
import * as submission from "./submission/index.ts"

export { enqueue } from "../outbound/index.ts"
export { buildBounce, sendBounce } from "./bounce/index.ts"
export { deliverToDomain, mxHostsOf, sendMessage } from "./client/index.ts"
export { drain, releaseStale } from "./queue/index.ts"
export { createSession } from "./session/index.ts"
export { isJunk, score as spamScore } from "./spam/index.ts"
export { reverse as srsReverse, rewrite as srsRewrite } from "./srs/index.ts"

type SocketData = {
  session: Session
  /** The client's address: the socket's, or what a trusted proxy reported. */
  remoteIp: string
  /** The address the socket itself came from, which nothing can forge. */
  socketIp: string
  /** True once a trusted proxy has identified the client it is relaying. */
  proxied: boolean
  helo: string
  identity: Identity | null
  secure: boolean
  upgradeRequested: boolean
  /** Set once STARTTLS succeeds; see the gate in `data`. */
  tlsSocket: Bun.Socket<SocketData> | null
}

/**
 * One listener factory for all three SMTP ports. They differ only in whether
 * the socket starts encrypted and which policy module answers — keeping them
 * one function is what stops the MX path and the submission path from drifting
 * apart, which is the drift that produces an open relay.
 */
const createListener = (input: {
  mode: SessionMode
  port: number
  bind: string
  implicitTls: boolean
  tls: { cert: string; key: string } | null
  label: string
}) => {
  // Never advertise STARTTLS the runtime cannot actually perform: a sender
  // that takes us up on it gets its connection dropped mid-handshake and
  // defers rather than falling back. See src/starttls.
  const canStartTls = Boolean(input.tls) && !input.implicitTls && canUpgradeServerSocketToTls()

  const handlers = {
    open(socket: Bun.Socket<SocketData>) {
      const socketIp = socket.remoteAddress ?? "unknown"
      // Whether *this peer* may speak XCLIENT, decided here from the socket and
      // never from anything the connection says about itself.
      const trustProxy = config.smtp.trustedProxies.includes(socketIp)
      const data: SocketData = {
        session: null as never,
        remoteIp: socketIp,
        socketIp,
        proxied: false,
        helo: "",
        identity: null,
        secure: input.implicitTls,
        upgradeRequested: false,
        tlsSocket: null,
      }

      data.session = createSession({
        mode: input.mode,
        hostname: config.hostname,
        maxSize: config.maxMessageBytes,
        remoteIp: socketIp,
        isSecure: () => data.secure,
        trustProxy,
        onProxy: (info) => {
          // The proxy's word replaces the socket's address for every purpose
          // downstream: SPF, the Received header, the bans, the rate limits.
          if (info.addr) data.remoteIp = info.addr
          data.proxied = true
          if (info.secure) data.secure = true
        },
        ...(canStartTls
          ? {
              startTls: () => {
                data.upgradeRequested = true
              },
            }
          : {}),
        authenticate:
          input.mode === "submission"
            ? async (username, password) => {
                const result = await submission.authenticate(username, password)
                if (result) {
                  data.identity = result
                  await clearAuthFailures(data.remoteIp).catch(() => {})
                } else {
                  await recordAuthFailure(data.remoteIp, "smtp", username).catch(() => {})
                }
                return result
              }
            : undefined,
        validateSender: (address, identity) =>
          input.mode === "submission"
            ? submission.validateSender(address, identity)
            : inbound.validateSender(address),
        validateRecipient: (address, identity, envelope) =>
          input.mode === "submission"
            ? submission.validateRecipient(address, identity)
            : inbound.validateRecipient(address, identity, envelope),
        handleMessage: (envelope, raw, identity) => {
          data.helo = envelope.helo
          return input.mode === "submission"
            ? submission.handleMessage(envelope, raw, identity)
            : inbound.handleMessage(envelope, raw, {
                remoteIp: data.remoteIp,
                helo: envelope.helo,
                // Only a connection that arrived on this socket from this
                // machine is us. A session relayed by the proxy is somebody
                // else's mail regardless of which address it came from.
                local: !data.proxied && isLoopback(data.socketIp),
              })
        },
        onQuit: () => {
          if (input.mode === "submission") submission.forget(data.identity)
        },
      })

      socket.data = data

      // A banned source gets a 421 and nothing else. Answering at all costs one
      // packet; answering properly costs an Argon2 hash per attempt.
      void isBanned(socketIp).then((banned) => {
        if (banned) {
          socket.write(`421 4.7.0 Too many failed attempts from ${socketIp}.\r\n`)
          socket.end()
          return
        }
        socket.write(data.session.greeting())
      })
    },

    async data(socket: Bun.Socket<SocketData>, chunk: Uint8Array) {
      const state = socket.data
      if (!state?.session) return

      // After an upgrade Bun delivers the encrypted stream to this handler on
      // the cleartext socket as well as the decrypted stream on the TLS socket
      // (oven-sh/bun#26297). Feeding the ciphertext to the session parses a
      // ClientHello as a command. Verified: every post-upgrade chunk arrives
      // twice.
      if (state.tlsSocket && socket !== state.tlsSocket) return

      const out = await state.session.feed(chunk)
      if (out) socket.write(out)

      if (state.upgradeRequested) {
        state.upgradeRequested = false
        try {
          const [, tlsSocket] = upgradeAcceptedSocket<SocketData>(socket, {
            tls: input.tls!,
            // NOT `handlers`. Bun runs `open` on the upgraded socket, and this
            // listener's `open` builds fresh state, starts a new session, and
            // writes a second greeting — so reusing it silently replaced the
            // connection with an unauthenticated one that still advertised
            // STARTTLS and no longer advertised AUTH. Carrying the existing
            // state across is the whole point of an in-place upgrade.
            socket: { ...handlers, open: (s: Bun.Socket<SocketData>) => (s.data = state) },
          })
          state.tlsSocket = tlsSocket
          tlsSocket.data = state
          state.secure = true
          // Everything a client said before the handshake is discarded: an
          // active attacker can inject commands into the plaintext prologue,
          // and carrying them across the upgrade is how that becomes a
          // vulnerability rather than a nuisance.
          state.session.resetAfterTls()
        } catch (e) {
          console.error("[corsair] STARTTLS upgrade failed:", (e as Error).message)
          socket.end()
        }
        return
      }

      if (state.session.shouldClose()) socket.end()
    },

    close(socket: Bun.Socket<SocketData>) {
      if (input.mode === "submission" && socket.data?.identity) {
        submission.forget(socket.data.identity)
      }
    },

    error(socket: Bun.Socket<SocketData>, error: Error) {
      console.error(`[corsair] ${input.label} socket error:`, error.message)
      socket.end()
    },
  }

  const listener = Bun.listen<SocketData>({
    hostname: input.bind,
    port: input.port,
    ...(input.implicitTls && input.tls ? { tls: input.tls } : {}),
    socket: handlers as never,
  })

  console.log(`[corsair] ${input.label.padEnd(11)} 0.0.0.0:${input.port}`)
  return listener
}

export const startSmtp = async (): Promise<void> => {
  const tls = await tlsOptions()

  if (!tls) {
    console.warn(
      "[corsair] no TLS certificate configured — STARTTLS is unavailable and SMTP AUTH will be refused.",
    )
  } else {
    // Emitted once, from the SMTP listener rather than all three, because port
    // 25 is where the consequence actually bites.
    warnIfStartTlsUnavailable()
  }

  createListener({
    mode: "mx",
    port: config.smtp.mxPort,
    bind: config.smtp.bind,
    implicitTls: false,
    tls,
    label: "smtp mx",
  })
  createListener({
    mode: "submission",
    port: config.smtp.submissionPort,
    bind: config.smtp.bind,
    implicitTls: false,
    tls,
    label: "submission",
  })

  if (tls) {
    createListener({
      mode: "submission",
      port: config.smtp.submissionTlsPort,
      // Not `config.smtp.bind`: that setting exists to put the two plaintext
      // listeners behind the STARTTLS terminator, and this port has no
      // plaintext phase to protect. Binding it to loopback with them would
      // take submission on 465 off the internet.
      bind: "0.0.0.0",
      implicitTls: true,
      tls,
      label: "submission+tls",
    })
  }
}
