import { clearAuthFailures, isBanned, recordAuthFailure } from "../auth/index.ts"
import { config } from "../config/index.ts"
import { createPop3Session, type Pop3Session } from "./session/index.ts"

export { createPop3Session } from "./session/index.ts"

type SocketData = {
  session: Pop3Session
  remoteIp: string
  secure: boolean
  upgradeRequested: boolean
}

const tlsOptions = async (): Promise<{ cert: string; key: string } | null> => {
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

const createListener = (input: {
  port: number
  implicitTls: boolean
  tls: { cert: string; key: string } | null
  label: string
}) => {
  const canStartTls = Boolean(input.tls) && !input.implicitTls

  const handlers = {
    open(socket: Bun.Socket<SocketData>) {
      const remoteIp = socket.remoteAddress ?? "unknown"
      const data: SocketData = {
        session: null as never,
        remoteIp,
        secure: input.implicitTls,
        upgradeRequested: false,
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
          void clearAuthFailures(remoteIp).catch(() => {})
        },
        onAuthFailure: (username) => {
          void recordAuthFailure(remoteIp, "pop3", username).catch(() => {})
        },
      })

      socket.data = data

      void isBanned(remoteIp).then((banned) => {
        if (banned) {
          socket.write(`-ERR Too many failed attempts from ${remoteIp}.\r\n`)
          socket.end()
          return
        }
        socket.write(data.session.greeting())
      })
    },

    async data(socket: Bun.Socket<SocketData>, chunk: Uint8Array) {
      const state = socket.data
      if (!state?.session) return

      const out = await state.session.feed(chunk)
      if (out) socket.write(out)

      if (state.upgradeRequested) {
        state.upgradeRequested = false
        try {
          socket.upgradeTLS({ socket: handlers as never, tls: input.tls! })
          state.secure = true
          state.session.resetAfterTls()
        } catch (e) {
          console.error("[corsair] POP3 STLS upgrade failed:", (e as Error).message)
          socket.end()
        }
        return
      }

      if (state.session.shouldClose()) socket.end()
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
