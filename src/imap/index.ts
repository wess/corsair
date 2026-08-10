import { clearAuthFailures, isBanned, recordAuthFailure } from "../auth/index.ts"
import { config } from "../config/index.ts"
import { canUpgradeServerSocketToTls } from "../starttls/index.ts"
import { createImapSession, type ImapSession } from "./session/index.ts"

export {
  parseFetchItems,
  renderBodyStructure,
  renderEnvelope,
  sectionBytes,
} from "./fetch/index.ts"
export {
  decodeMailbox,
  encodeMailbox,
  formatSequenceSet,
  parseSequenceSet,
} from "./protocol/index.ts"
export { matches, parseSearch, parseSortKeys, sortCandidates } from "./search/index.ts"
export { createImapSession } from "./session/index.ts"

type SocketData = {
  session: ImapSession
  remoteIp: string
  secure: boolean
  upgradeRequested: boolean
  idleTimer: ReturnType<typeof setInterval> | null
}

const IDLE_POLL_MS = 5000

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
        idleTimer: null,
      }

      data.session = createImapSession({
        isSecure: () => data.secure,
        remoteIp,
        push: (payload) => socket.write(payload),
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
          void recordAuthFailure(remoteIp, "imap", username).catch(() => {})
        },
      })

      socket.data = data

      void isBanned(remoteIp).then((banned) => {
        if (banned) {
          socket.write(`* BYE Too many failed attempts from ${remoteIp}.\r\n`)
          socket.end()
          return
        }
        socket.write(data.session.greeting())
      })

      // IDLE is a promise to tell the client about changes it did not ask for.
      // Polling is the honest implementation on top of Postgres: LISTEN/NOTIFY
      // would be tighter but needs a dedicated connection per session, and at
      // one mailbox per five seconds this costs a single indexed query.
      data.idleTimer = setInterval(() => {
        if (!data.session.isIdling()) return
        void data.session
          .poll()
          .then((out) => {
            if (out) socket.write(out)
          })
          .catch(() => {})
      }, IDLE_POLL_MS)
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
          console.error("[corsair] IMAP STARTTLS upgrade failed:", (e as Error).message)
          socket.end()
        }
        return
      }

      if (state.session.shouldClose()) socket.end()
    },

    close(socket: Bun.Socket<SocketData>) {
      if (socket.data?.idleTimer) clearInterval(socket.data.idleTimer)
      socket.data?.session?.close()
    },

    error(socket: Bun.Socket<SocketData>, error: Error) {
      console.error(`[corsair] ${input.label} socket error:`, error.message)
      if (socket.data?.idleTimer) clearInterval(socket.data.idleTimer)
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

export const startImap = async (): Promise<void> => {
  const tls = await tlsOptions()
  if (!tls) {
    console.warn(
      "[corsair] no TLS certificate configured — IMAP will advertise LOGINDISABLED and refuse logins.",
    )
  }

  createListener({ port: config.imap.port, implicitTls: false, tls, label: "imap" })
  if (tls) {
    createListener({ port: config.imap.tlsPort, implicitTls: true, tls, label: "imaps" })
  }
}
