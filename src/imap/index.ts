import { clearAuthFailures, isBanned, recordAuthFailure } from "../auth/index.ts"
import { config } from "../config/index.ts"
import { createReader, createWriter, type SocketWriter } from "../socketio/index.ts"
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
  authed: boolean
  /** Every write goes through this; see `src/socketio`. */
  writer: SocketWriter
  /** Chains `data` handlers; see the note there. */
  reader: ReturnType<typeof createReader>
}

const IDLE_POLL_MS = 5000

// Seconds of silence before a connection is dropped. Short until the client has
// logged in — an unauthenticated connection has no business sitting idle, and
// every one holds a socket, a session, and a 5 s timer — and long after, because
// IDLE is a promise to hold a quiet connection open for up to 29 minutes.
const PRE_AUTH_IDLE = 120
const AUTHED_IDLE = 3600

export const createListener = (input: {
  port: number
  implicitTls: boolean
  tls: { cert: string; key: string } | null
  label: string
}) => {
  // Never advertise STARTTLS the runtime cannot actually perform: a sender
  // that takes us up on it gets its connection dropped mid-handshake and
  // defers rather than falling back. See src/starttls.
  const canStartTls = Boolean(input.tls) && !input.implicitTls && canUpgradeServerSocketToTls()

  const handleChunk = async (socket: Bun.Socket<SocketData>, chunk: Uint8Array) => {
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
        console.error("[corsair] IMAP STARTTLS upgrade failed:", (e as Error).message)
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
        secure: input.implicitTls,
        upgradeRequested: false,
        tlsSocket: null,
        idleTimer: null,
        authed: false,
        reader: null as never,
        writer: null as never,
      }
      data.writer = createWriter(() => data.tlsSocket ?? socket)

      data.session = createImapSession({
        isSecure: () => data.secure,
        remoteIp,
        push: (payload) => data.writer.write(payload),
        // Used by FETCH to send a large response one message at a time and wait
        // for the client to keep up, instead of building it all in memory.
        stream: async (chunk) => {
          if ((data.tlsSocket ?? socket).readyState <= 0)
            throw new Error("The client disconnected.")
          data.writer.write(chunk)
          await data.writer.settled()
        },
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
          void recordAuthFailure(remoteIp, "imap", username).catch(() => {})
        },
      })

      data.reader = createReader(
        async (chunk) => {
          if (await ready) await handleChunk(data.tlsSocket ?? socket, chunk)
        },
        () => socket.end(),
        config.maxMessageBytes + 64 * 1024,
      )
      socket.data = data
      socket.timeout(PRE_AUTH_IDLE)

      const ready = isBanned(remoteIp)
        .then((banned) => {
          if (banned) {
            data.writer.write(`* BYE Too many failed attempts from ${remoteIp}.\r\n`)
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

      // IDLE is a promise to tell the client about changes it did not ask for.
      // Polling is the honest implementation on top of Postgres: LISTEN/NOTIFY
      // would be tighter but needs a dedicated connection per session, and at
      // one mailbox per five seconds this costs a single indexed query.
      data.idleTimer = setInterval(() => {
        if (!data.session.isIdling()) return
        void data.session
          .poll()
          .then((out) => {
            if (out) data.writer.write(out)
          })
          .catch(() => {})
      }, IDLE_POLL_MS)
    },

    // A connection that has said nothing for too long is closed, not waited on.
    timeout(socket: Bun.Socket<SocketData>) {
      socket.end()
    },

    /**
     * Bun runs an async `data` handler for the next chunk while the previous
     * one is still awaiting, so two pipelined commands in separate packets were
     * being fed to the session concurrently — the second appended to a command
     * the first had not finished, and the client got a wrong answer and a tag
     * that was never replied to. Real clients pipeline (SELECT, then FETCH), so
     * each socket's chunks are chained and handled strictly in order.
     */
    data(socket: Bun.Socket<SocketData>, chunk: Uint8Array) {
      const state = socket.data
      if (!state?.session) return
      if (state.tlsSocket && socket !== state.tlsSocket) return
      return state.reader.feed(chunk)
    },

    // The socket has room again: write what it could not take before.
    drain(socket: Bun.Socket<SocketData>) {
      socket.data?.writer?.drain()
    },

    close(socket: Bun.Socket<SocketData>) {
      if (socket.data?.tlsSocket && socket !== socket.data.tlsSocket) return
      socket.data?.reader?.close()
      socket.data?.writer?.close()
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
