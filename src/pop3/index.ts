import { clearAuthFailures, isBanned, recordAuthFailure } from "../auth/index.ts"
import { config } from "../config/index.ts"
import { createWriter, type SocketWriter } from "../socketio/index.ts"
import { canUpgradeServerSocketToTls, upgradeAcceptedSocket } from "../starttls/index.ts"
import { tlsOptions } from "../tls/index.ts"
import { createPop3Session, type Pop3Session } from "./session/index.ts"

export { createPop3Session } from "./session/index.ts"

// Short until the client has logged in, then the RFC 1939 minimum of ten minutes.
const PRE_AUTH_IDLE = 120
const AUTHED_IDLE = 600

type SocketData = {
  session: Pop3Session
  remoteIp: string
  secure: boolean
  upgradeRequested: boolean
  /** Set once STARTTLS succeeds; see the gate in `data`. */
  tlsSocket: Bun.Socket<SocketData> | null
  /** Every write goes through this; see `src/socketio`. */
  writer: SocketWriter
  authed: boolean
}

const createListener = (input: {
  port: number
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
      const remoteIp = socket.remoteAddress ?? "unknown"
      const data: SocketData = {
        session: null as never,
        remoteIp,
        secure: input.implicitTls,
        upgradeRequested: false,
        tlsSocket: null,
        writer: null as never,
        authed: false,
      }

      data.session = createPop3Session({
        isSecure: () => data.secure,
        remoteIp,
        ...(canStartTls
          ? {
              startTls: () => {
                data.upgradeRequested = true
              },
            }
          : {}),
        onAuthSuccess: () => {
          data.authed = true
          ;(data.tlsSocket ?? socket).timeout(AUTHED_IDLE)
          void clearAuthFailures(remoteIp).catch(() => {})
        },
        onAuthFailure: (username) => {
          void recordAuthFailure(remoteIp, "pop3", username).catch(() => {})
        },
      })

      data.writer = createWriter(() => data.tlsSocket ?? socket)
      socket.data = data
      socket.timeout(PRE_AUTH_IDLE)

      void isBanned(remoteIp).then((banned) => {
        if (banned) {
          data.writer.write(`-ERR Too many failed attempts from ${remoteIp}.\r\n`)
          data.writer.afterFlush(() => socket.end())
          return
        }
        data.writer.write(data.session.greeting())
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
      if (out) state.writer.write(out)

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
            socket: {
              ...handlers,
              open: (s: Bun.Socket<SocketData>) => {
                s.data = state
                s.timeout(state.authed ? AUTHED_IDLE : PRE_AUTH_IDLE)
              },
            },
          })
          state.tlsSocket = tlsSocket
          tlsSocket.data = state
          state.secure = true
          state.session.resetAfterTls()
        } catch (e) {
          console.error("[corsair] POP3 STLS upgrade failed:", (e as Error).message)
          socket.end()
        }
        return
      }

      if (state.session.shouldClose()) state.writer.afterFlush(() => socket.end())
    },

    drain(socket: Bun.Socket<SocketData>) {
      socket.data?.writer?.drain()
    },

    timeout(socket: Bun.Socket<SocketData>) {
      socket.end()
    },

    error(socket: Bun.Socket<SocketData>, error: Error) {
      console.error(`[corsair] ${input.label} socket error:`, error.message)
      socket.end()
    },
  }

  const listener = Bun.listen<SocketData>({
    hostname: "0.0.0.0",
    port: input.port,
    ...(input.implicitTls && input.tls ? { tls: input.tls } : {}),
    socket: handlers as never,
  })

  console.log(`[corsair] ${input.label.padEnd(11)} 0.0.0.0:${input.port}`)
  return listener
}

export const startPop3 = async (): Promise<void> => {
  const tls = await tlsOptions()
  if (!tls) {
    console.warn("[corsair] no TLS certificate configured — POP3 will refuse logins.")
  }

  createListener({ port: config.pop3.port, implicitTls: false, tls, label: "pop3" })
  if (tls) {
    createListener({ port: config.pop3.tlsPort, implicitTls: true, tls, label: "pop3s" })
  }
}
