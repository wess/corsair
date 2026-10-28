import { clearAuthFailures, isBanned, recordAuthFailure } from "../auth/index.ts"
import { config } from "../config/index.ts"
import { createReader, createWriter, type SocketWriter } from "../socketio/index.ts"
import { canUpgradeServerSocketToTls, upgradeAcceptedSocket } from "../starttls/index.ts"
import { type TlsMaterial, tlsOptions } from "../tls/index.ts"
import { createManageSieveSession, type ManageSieveSession } from "./session/index.ts"

export { createManageSieveSession } from "./session/index.ts"

// Short until the client has logged in; an editor left open in a settings tab is normal after.
const PRE_AUTH_IDLE = 120
const AUTHED_IDLE = 600

type SocketData = {
  session: ManageSieveSession
  remoteIp: string
  secure: boolean
  upgradeRequested: boolean
  /** Set once STARTTLS succeeds; see the gate in `data`. */
  tlsSocket: Bun.Socket<SocketData> | null
  /** Every write goes through this; see `src/socketio`. */
  reader: ReturnType<typeof createReader>
  writer: SocketWriter
  authed: boolean
}

/**
 * Binds one ManageSieve listener. There is no implicit-TLS port: the protocol
 * defines none, so clients always arrive in the clear and upgrade with
 * STARTTLS. `implicitTls` exists for tests, which cannot do the upgrade
 * without a runtime that supports it.
 */
export const listenManageSieve = (input: {
  port: number
  hostname?: string
  implicitTls?: boolean
  tls: TlsMaterial | null
}) => {
  const implicitTls = Boolean(input.implicitTls && input.tls)
  // Never advertise STARTTLS the runtime cannot perform. See src/starttls.
  const canStartTls = Boolean(input.tls) && !implicitTls && canUpgradeServerSocketToTls()

  const handleChunk = async (socket: Bun.Socket<SocketData>, chunk: Uint8Array) => {
    const state = socket.data
    if (!state?.session) return

    // Bun delivers the post-upgrade stream to the cleartext socket too
    // (oven-sh/bun#26297); parsing that ciphertext would run a ClientHello as a command.
    if (state.tlsSocket && socket !== state.tlsSocket) return

    const out = await state.session.feed(chunk)
    if (out) state.writer.write(out)

    if (state.upgradeRequested) {
      state.upgradeRequested = false
      try {
        const [, tlsSocket] = upgradeAcceptedSocket<SocketData>(socket, {
          tls: input.tls!,
          // NOT `handlers`: its `open` would build fresh state and greet again,
          // replacing this connection with an unauthenticated one.
          socket: {
            ...handlers,
            open: (s: Bun.Socket<SocketData>) => {
              s.data = state
              s.timeout(PRE_AUTH_IDLE)
            },
          },
        })
        state.tlsSocket = tlsSocket
        tlsSocket.data = state
        state.secure = true
        // The capability list changes with TLS (SASL PLAIN appears), and the
        // client is told rather than left holding the cleartext one.
        state.writer.write(state.session.resetAfterTls())
      } catch (e) {
        console.error("[corsair] ManageSieve STARTTLS upgrade failed:", (e as Error).message)
        socket.end()
      }
      return
    }

    if (state.session.shouldClose()) state.writer.afterFlush(() => socket.end())
  }

  const handlers = {
    open(socket: Bun.Socket<SocketData>) {
      const remoteIp = socket.remoteAddress ?? "unknown"
      const data: SocketData = {
        session: null as never,
        remoteIp,
        secure: implicitTls,
        upgradeRequested: false,
        tlsSocket: null,
        reader: null as never,
        writer: null as never,
        authed: false,
      }

      data.session = createManageSieveSession({
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
          void recordAuthFailure(remoteIp, "managesieve", username).catch(() => {})
        },
      })

      data.writer = createWriter(() => data.tlsSocket ?? socket)
      data.reader = createReader(
        async (chunk) => {
          if (await ready) await handleChunk(data.tlsSocket ?? socket, chunk)
        },
        () => socket.end(),
        1024 * 1024,
      )
      socket.data = data
      socket.timeout(PRE_AUTH_IDLE)

      const ready = isBanned(remoteIp)
        .then((banned) => {
          if (banned) {
            data.writer.write(`BYE "Too many failed attempts from ${remoteIp}."\r\n`)
            data.writer.afterFlush(() => socket.end())
            return false
          }
          data.writer.write(data.session.greeting())
          return true
        })
        .catch(() => {
          socket.end()
          return false
        })
    },

    data(socket: Bun.Socket<SocketData>, chunk: Uint8Array) {
      const state = socket.data
      if (state?.tlsSocket && socket !== state.tlsSocket) return
      return state?.reader?.feed(chunk)
    },

    drain(socket: Bun.Socket<SocketData>) {
      socket.data?.writer?.drain()
    },

    timeout(socket: Bun.Socket<SocketData>) {
      socket.end()
    },

    close(socket: Bun.Socket<SocketData>) {
      if (socket.data?.tlsSocket && socket !== socket.data.tlsSocket) return
      socket.data?.reader?.close()
      socket.data?.writer?.close()
    },

    error(socket: Bun.Socket<SocketData>, error: Error) {
      console.error("[corsair] managesieve socket error:", error.message)
      socket.end()
    },
  }

  return Bun.listen<SocketData>({
    hostname: input.hostname ?? "0.0.0.0",
    port: input.port,
    ...(implicitTls && input.tls ? { tls: input.tls } : {}),
    socket: handlers as never,
  })
}

export const startManagesieve = async (): Promise<void> => {
  const tls = await tlsOptions()
  if (!tls) {
    console.warn("[corsair] no TLS certificate configured — ManageSieve will refuse logins.")
  }

  listenManageSieve({ port: config.managesieve.port, tls })
  console.log(`[corsair] ${"managesieve".padEnd(11)} 0.0.0.0:${config.managesieve.port}`)
}
