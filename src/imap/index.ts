import { clearAuthFailures, isBanned, recordAuthFailure } from "../auth/index.ts"
import { config } from "../config/index.ts"
import { canUpgradeServerSocketToTls, upgradeAcceptedSocket } from "../starttls/index.ts"
import { tlsOptions } from "../tls/index.ts"
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
  /** Set once STARTTLS succeeds; see the gate in `data`. */
  tlsSocket: Bun.Socket<SocketData> | null
  idleTimer: ReturnType<typeof setInterval> | null
}

const IDLE_POLL_MS = 5000

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
