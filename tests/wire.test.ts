import { describe, expect, test } from "bun:test"
import { createWriter } from "../src/socketio/index.ts"

/**
 * Bytes on a real socket, with a reader that is slower than the writer. This is the
 * part of the system the session-level tests could not see: they hand strings back
 * and never touch the wire, which is how a 60 MB write that delivered 327 KB and a
 * UTF-8 re-encoding of every 8-bit byte went unnoticed.
 */

type Harness = { received: Uint8Array; done: Promise<void> }

const serve = async (
  produce: (writer: ReturnType<typeof createWriter>) => Promise<void> | void,
  options: { delayMs?: number } = {},
): Promise<Harness> => {
  const chunks: Uint8Array[] = []
  let finish!: () => void
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        const writer = createWriter(() => socket)
        ;(socket as unknown as { writer: typeof writer }).writer = writer
        void Promise.resolve(produce(writer)).then(() => {
          // End once everything queued has gone out.
          const wait = () => (writer.backlog() ? setTimeout(wait, 5) : socket.end())
          wait()
        })
      },
      drain(socket) {
        ;(socket as unknown as { writer: ReturnType<typeof createWriter> }).writer.drain()
      },
      data() {},
    },
  })

  await new Promise<void>((resolve) => {
    Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        async data(_s, chunk) {
          chunks.push(new Uint8Array(chunk))
          if (options.delayMs) await Bun.sleep(options.delayMs)
        },
        close() {
          finish()
        },
        open() {
          resolve()
        },
      },
    })
  })

  return {
    get received() {
      return Buffer.concat(chunks)
    },
    done: done.finally(() => server.stop(true)),
  }
}

describe("createWriter", () => {
  test("a response larger than the socket buffer arrives whole", async () => {
    const size = 40_000_000
    const body = "x".repeat(size)
    const wire = await serve((w) => w.write(body), { delayMs: 1 })
    await wire.done
    expect(wire.received.length).toBe(size)
  })

  test("latin1 strings go out as the bytes they hold, not as UTF-8", async () => {
    // "é" as the two UTF-8 bytes C3 A9, the way the mail pipeline stores it.
    const raw = Buffer.from("café €", "utf8").toString("latin1")
    const wire = await serve((w) => w.write(raw))
    await wire.done
    expect([...wire.received]).toEqual([...Buffer.from("café €", "utf8")])
  })

  test("every byte value survives, in order, across slice boundaries", async () => {
    const bytes = new Uint8Array(1_500_000)
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 8)) & 0xff
    const asString = Buffer.from(bytes).toString("latin1")
    const wire = await serve((w) => {
      w.write("A:")
      w.write(asString)
      w.write(bytes) // a binary chunk after a string one, same stream
      w.write(":Z")
    })
    await wire.done
    const expected = Buffer.concat([
      Buffer.from("A:"),
      Buffer.from(bytes),
      Buffer.from(bytes),
      Buffer.from(":Z"),
    ])
    expect(wire.received.length).toBe(expected.length)
    expect(Buffer.compare(wire.received, expected)).toBe(0)
  })

  test("a producer that waits on settled() never queues much", async () => {
    let peak = 0
    const wire = await serve(
      async (w) => {
        const piece = "y".repeat(500_000)
        for (let i = 0; i < 60; i++) {
          w.write(piece)
          peak = Math.max(peak, w.backlog())
          await w.settled()
        }
      },
      { delayMs: 2 },
    )
    await wire.done
    expect(wire.received.length).toBe(60 * 500_000)
    // 30 MB went through; never more than a couple of MB was waiting at once.
    expect(peak).toBeLessThan(3_000_000)
  })
})

describe("afterFlush", () => {
  test("ends the socket only after the queue has gone out", async () => {
    const size = 20_000_000
    const chunks: Uint8Array[] = []
    let finish!: () => void
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          const writer = createWriter(() => socket)
          ;(socket as unknown as { writer: typeof writer }).writer = writer
          writer.write("x".repeat(size))
          // The mistake this guards against: ending straight after write().
          writer.afterFlush(() => socket.end())
        },
        drain(socket) {
          ;(socket as unknown as { writer: ReturnType<typeof createWriter> }).writer.drain()
        },
        data() {},
      },
    })
    Bun.connect({
      hostname: "127.0.0.1",
      port: server.port,
      socket: {
        async data(_s, chunk) {
          chunks.push(new Uint8Array(chunk))
          await Bun.sleep(1)
        },
        close() {
          finish()
        },
        open() {},
      },
    })
    await done
    server.stop(true)
    expect(Buffer.concat(chunks).length).toBe(size)
  })
})

// The outbound client, end to end against a fake MX on a real socket.

import { sendMessage } from "../src/smtp/client/index.ts"

type Capture = { body: Buffer; sizeParam: string | null }

/** An SMTP server that reads DATA slowly and keeps exactly what it was sent. */
const fakeMx = (): { port: number; captured: Promise<Capture>; stop: () => void } => {
  let resolve!: (c: Capture) => void
  const captured = new Promise<Capture>((r) => {
    resolve = r
  })
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        ;(socket as unknown as { state: unknown }).state = {
          mode: "cmd",
          buf: Buffer.alloc(0),
          data: [] as Buffer[],
          size: null,
        }
        socket.write("220 fake ESMTP\r\n")
      },
      async data(socket, chunk) {
        const state = (
          socket as unknown as {
            state: { mode: string; buf: Buffer; data: Buffer[]; size: string | null }
          }
        ).state
        if (state.mode === "data") {
          state.data.push(Buffer.from(chunk))
          const all = Buffer.concat(state.data)
          if (all.subarray(-5).toString("latin1") === "\r\n.\r\n") {
            state.mode = "cmd"
            // Dot-unstuffing and the terminator, as a real server does.
            const body = all.subarray(0, all.length - 3)
            const unstuffed = Buffer.from(
              body.toString("latin1").replace(/(^|\r\n)\.\./g, "$1."),
              "latin1",
            )
            resolve({ body: unstuffed, sizeParam: state.size })
            socket.write("250 queued\r\n")
          } else {
            await Bun.sleep(1)
          }
          return
        }
        for (const line of Buffer.from(chunk).toString("latin1").split("\r\n").filter(Boolean)) {
          const verb = line.slice(0, 4).toUpperCase()
          if (verb === "EHLO") socket.write("250-fake\r\n250 SIZE 100000000\r\n")
          else if (verb === "MAIL") {
            state.size = /SIZE=(\d+)/.exec(line)?.[1] ?? null
            socket.write("250 ok\r\n")
          } else if (verb === "RCPT") socket.write("250 ok\r\n")
          else if (verb === "DATA") {
            state.mode = "data"
            socket.write("354 go\r\n")
          } else if (verb === "QUIT") {
            socket.write("221 bye\r\n")
            socket.end()
          }
        }
      },
      drain() {},
    },
  })
  return { port: server.port, captured, stop: () => server.stop(true) }
}

describe("sendMessage over a real socket", () => {
  test("a large message with 8-bit bytes and dot-leading lines arrives byte for byte", async () => {
    // UTF-8 stored the way the pipeline holds it: one character per byte.
    const utf8Line = Buffer.from("Grüße aus München — café €\r\n", "utf8").toString("latin1")
    let body = ""
    while (body.length < 6_000_000)
      body += `${utf8Line}.starts with a dot\r\n..two dots\r\nplain line\r\n`
    const raw = `From: a@b.invalid\r\nTo: c@d.invalid\r\nSubject: big\r\n\r\n${body}`

    const mx = fakeMx()
    try {
      const result = await sendMessage({
        host: "127.0.0.1",
        port: mx.port,
        mailFrom: "a@b.invalid",
        rcptTo: "c@d.invalid",
        raw,
        timeoutMs: 60_000,
      })
      expect(result.ok).toBe(true)
      const got = await mx.captured
      const expected = Buffer.from(raw, "latin1")
      // The terminator adds nothing when the body already ends in CRLF.
      expect(got.body.length).toBe(expected.length)
      expect(Buffer.compare(got.body, expected)).toBe(0)
      expect(got.sizeParam).toBe(String(raw.length))
    } finally {
      mx.stop()
    }
  })
})
