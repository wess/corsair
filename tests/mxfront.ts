/**
 * The STARTTLS terminator, against a real handshake.
 *
 *   bun run test:mxfront
 *
 * Starts the Rust front in front of a recording SMTP backend, then drives it
 * with a client that actually upgrades. What is being proved is not "the
 * process runs" but the four things the mail path depends on:
 *
 *   - STARTTLS is advertised, though the backend never offers it
 *   - the upgrade completes and the rest of the session is encrypted
 *   - the backend is told the client's real address before anything else, and
 *     told again after the upgrade that the session is now encrypted
 *   - the message body arrives intact on the far side
 *
 * The last one is the one that catches a relay bug: a buffer handed on twice,
 * or dropped at the moment of the upgrade, produces a session that looks
 * healthy and delivers corrupt mail.
 *
 * Needs the release binary: cargo build --release --manifest-path engine/Cargo.toml
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const BACKEND_PORT = 21_000 + Math.floor(Math.random() * 500)
const FRONT_PORT = 21_500 + Math.floor(Math.random() * 500)
const BINARY = new URL("../engine/target/release/corsair-mxfront", import.meta.url).pathname

let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++
    console.log(`  ok    ${label}`)
    return
  }
  failed++
  console.error(`  FAIL  ${label}`)
  if (detail !== undefined) console.error(`        ${String(detail).slice(0, 300)}`)
}

const dir = await mkdtemp(join(tmpdir(), "corsair-mxfront-"))
const seen: string[] = []
let body = ""

// A backend that speaks just enough SMTP, and never offers STARTTLS — which is
// the situation this whole component exists for.
const backend = Bun.listen<{ inData: boolean }>({
  hostname: "127.0.0.1",
  port: BACKEND_PORT,
  socket: {
    open(socket) {
      socket.data = { inData: false }
      socket.write("220 backend.test ESMTP\r\n")
    },
    data(socket, chunk) {
      const text = Buffer.from(chunk).toString("latin1")
      if (socket.data.inData) {
        body += text
        if (body.includes("\r\n.\r\n")) {
          socket.data.inData = false
          socket.write("250 2.0.0 Accepted\r\n")
        }
        return
      }
      for (const line of text.split("\r\n").filter(Boolean)) {
        seen.push(line)
        const verb = line.split(" ")[0]?.toUpperCase()
        if (verb === "XCLIENT") socket.write("220 backend.test ESMTP\r\n")
        else if (verb === "EHLO") socket.write("250-backend.test\r\n250-SIZE 1000\r\n250 HELP\r\n")
        else if (verb === "MAIL" || verb === "RCPT") socket.write("250 2.1.0 OK\r\n")
        else if (verb === "DATA") {
          socket.data.inData = true
          socket.write("354 Go ahead\r\n")
        } else if (verb === "QUIT") socket.write("221 2.0.0 Bye\r\n")
        else socket.write("250 2.0.0 OK\r\n")
      }
    },
  },
})

let front: Bun.Subprocess | null = null
try {
  await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -keyout ${join(dir, "key.pem")} -out ${join(dir, "cert.pem")} \
    -subj /CN=front.invalid`.quiet()

  front = Bun.spawn([BINARY], {
    env: {
      ...process.env,
      MXFRONT_CERT: join(dir, "cert.pem"),
      MXFRONT_KEY: join(dir, "key.pem"),
      MXFRONT_ROUTES: `127.0.0.1:${FRONT_PORT}=127.0.0.1:${BACKEND_PORT}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  // Wait for the listener rather than guessing at a delay.
  const deadline = Date.now() + 10_000
  for (;;) {
    try {
      const probe = await Bun.connect({
        hostname: "127.0.0.1",
        port: FRONT_PORT,
        socket: { data() {} },
      })
      probe.end()
      break
    } catch {
      if (Date.now() > deadline) throw new Error("the front never started listening")
      await Bun.sleep(100)
    }
  }

  let buffer = ""
  /**
   * Set the moment the upgrade begins, and never cleared.
   *
   * Bun delivers the post-upgrade stream to the cleartext socket as well as the
   * TLS one (oven-sh/bun#26297), so without this gate the handler below keeps
   * appending ciphertext into the same buffer the decrypted replies land in —
   * and every assertion after the handshake reads a mixture of both.
   */
  let upgraded = false
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: FRONT_PORT,
    socket: {
      data(_s: unknown, chunk: Uint8Array) {
        if (upgraded) return
        buffer += Buffer.from(chunk).toString("latin1")
      },
    } as never,
  })

  const take = async (ms = 500) => {
    await Bun.sleep(ms)
    const out = buffer
    buffer = ""
    return out
  }

  const greeting = await take()
  check("the client is greeted", greeting.startsWith("220 "), greeting)

  socket.write("EHLO client.test\r\n")
  const ehlo = await take()
  check("STARTTLS is advertised, though the backend never offered it", ehlo.includes("STARTTLS"))
  check(
    "the advertisement does not break the reply's last line",
    /\r\n250 [^\r\n]*\r\n$/.test(ehlo),
    ehlo,
  )

  socket.write("STARTTLS\r\n")
  const ready = await take()
  check("the upgrade is accepted", ready.startsWith("220 "), ready)

  // Bun can upgrade a socket it opened; only the accepted side is missing.
  let handshake: { ok: boolean; error?: string } = { ok: false }
  upgraded = true
  let tls!: { write: (data: string) => void; end: () => void }
  await new Promise<void>((resolve) => {
    const [, upgraded] = (
      socket as unknown as {
        upgradeTLS: (o: unknown) => [unknown, typeof tls]
      }
    ).upgradeTLS({
      tls: { rejectUnauthorized: false, serverName: "front.invalid" },
      socket: {
        data(_s: unknown, chunk: Uint8Array) {
          buffer += Buffer.from(chunk).toString("latin1")
        },
        handshake(_s: unknown, ok: boolean, error?: Error) {
          handshake = { ok, error: error?.message }
          resolve()
        },
        open() {},
        close() {},
        error() {},
        drain() {},
      },
    })
    tls = upgraded
  })
  check("the TLS handshake completes", handshake.ok, handshake.error)

  tls.write("EHLO client.test\r\n")
  const second = await take()
  check("the session continues over TLS", second.includes("250"), second)

  tls.write("MAIL FROM:<probe@example.test>\r\n")
  await take(300)
  tls.write("RCPT TO:<someone@backend.test>\r\n")
  await take(300)
  tls.write("DATA\r\n")
  const dataReply = await take(300)
  check("DATA is accepted over TLS", dataReply.startsWith("354"), dataReply)

  tls.write("Subject: through the front\r\n\r\nMXFRONT-PROBE-BODY\r\n.\r\n")
  const accepted = await take(600)
  check("the message is accepted", accepted.startsWith("250"), accepted)
  check("the body arrived intact", body.includes("MXFRONT-PROBE-BODY"), body.slice(0, 120))

  tls.write("QUIT\r\n")
  await take(200)

  const xclients = seen.filter((l) => l.toUpperCase().startsWith("XCLIENT"))
  check(
    "the backend is told the client's address before anything else",
    xclients[0]?.includes("ADDR=127.0.0.1") === true && seen[0] === xclients[0],
    seen.slice(0, 3).join(" | "),
  )
  check(
    "the backend is told the session became encrypted",
    xclients.some((l) => l.toUpperCase().includes("PROTO=ESMTPS")),
    xclients.join(" | "),
  )
  check(
    "the client's own STARTTLS never reaches the backend",
    !seen.some((l) => l.toUpperCase().startsWith("STARTTLS")),
    seen.join(" | "),
  )
} catch (e) {
  check("the run completed", false, (e as Error).message)
} finally {
  front?.kill()
  backend.stop(true)
  await rm(dir, { recursive: true, force: true })
}

console.log(`\nmxfront: ${failed === 0 ? "pass" : "FAIL"} — ${passed} ok, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
