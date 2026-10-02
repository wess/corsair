/**
 * Writing to a socket without losing or changing bytes.
 *
 * Bun's `socket.write` has two behaviours that a mail server cannot live with, and
 * both were in every listener and in the outbound SMTP client:
 *
 *   1. It writes as much as the kernel will take *now* and returns that count. The
 *      rest is not queued — it is gone. A response larger than the socket buffer
 *      (an IMAP FETCH of a big message, a POP3 RETR, an outbound DATA body) was
 *      silently cut short, and the peer waited forever for the rest of a literal.
 *      Measured: a 60 MB write to a slow reader delivered 327,212 bytes.
 *   2. A string is encoded as UTF-8. Everything on the wire here is a latin1
 *      string holding raw octets, so a message with an 8-bit byte went out
 *      double-encoded (`c3 a9` became `c3 83 c2 a9`), which also made every IMAP
 *      literal's declared size wrong.
 *
 * `createWriter` fixes both: strings go out as latin1, whatever the socket will
 * not take is queued and written on `drain`, and `settled()` lets a caller that is
 * producing a lot of output wait until the peer has caught up, so a client that
 * reads slowly cannot make the server buffer a mailbox's worth in memory.
 */

type Writable = { write: (data: Uint8Array) => number }

export type SocketWriter = {
  /** Queues `data`. Strings are latin1: one character, one byte. */
  write: (data: string | Uint8Array) => void
  /** Call from the socket's `drain` handler. */
  drain: () => void
  /** Bytes accepted but not yet taken by the socket. */
  backlog: () => number
  /** Resolves once the backlog is small again. Resolves at once when it already is. */
  settled: () => Promise<void>
  /**
   * Runs `then` once everything queued has been written — the moment to `end()`
   * the socket. Ending sooner drops whatever the socket had not yet taken, which
   * is how a `BYE` or a LOGOUT reply after a large response would be lost.
   */
  afterFlush: (then: () => void) => void
}

// Strings are turned into bytes a slice at a time, when they are about to be
// written, so a 25 MB message is never held twice at full size.
const SLICE = 256 * 1024

// Past this the producer should wait; below it, it may carry on.
const HIGH_WATER = 1024 * 1024

type Pending = { data: string | Uint8Array; offset: number }

export const createWriter = (current: () => Writable): SocketWriter => {
  const queue: Pending[] = []
  let queued = 0
  const waiters: (() => void)[] = []
  const flushed: (() => void)[] = []

  const lengthOf = (data: string | Uint8Array): number => data.length

  const release = () => {
    if (queued > HIGH_WATER) return
    while (waiters.length) waiters.shift()!()
  }

  /** Writes from the front of the queue until the socket stops taking bytes. */
  const flush = () => {
    const socket = current()
    while (queue.length) {
      const head = queue[0]!
      const end = Math.min(head.offset + SLICE, lengthOf(head.data))
      const bytes =
        typeof head.data === "string"
          ? Buffer.from(head.data.slice(head.offset, end), "latin1")
          : head.data.subarray(head.offset, end)

      const taken = socket.write(bytes)
      if (taken < 0) return // a closed socket reports -1; keep the queue for `drain`
      head.offset += taken
      queued -= taken

      if (head.offset >= lengthOf(head.data)) {
        queue.shift()
        continue
      }
      // The socket took less than we offered, so it is full. A string slice is
      // latin1, so bytes taken is characters taken and the offset stays exact.
      if (taken < bytes.length) break
    }
    release()
    if (!queue.length) while (flushed.length) flushed.shift()!()
  }

  return {
    write(data) {
      if (!lengthOf(data)) return
      queue.push({ data, offset: 0 })
      queued += lengthOf(data)
      flush()
    },
    drain: flush,
    backlog: () => queued,
    afterFlush(then) {
      if (!queue.length) then()
      else flushed.push(then)
    },
    settled: () =>
      queued <= HIGH_WATER
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push(resolve)
          }),
  }
}
