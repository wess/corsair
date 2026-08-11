/**
 * Drives the real outbound SMTP client through a real STARTTLS handshake,
 * against a local server, delivering nothing to anybody.
 *
 *   bun run test:starttls
 *
 * This is the blind spot that let a broken upgrade ship once already: every
 * other test either uses implicit TLS or talks to a peer that does not offer
 * STARTTLS, so the upgrade path never executed. Against a real MX it runs on
 * every single delivery.
 *
 * The peer is `tests/support/starttlsserver.py` because Bun cannot perform a
 * server-side TLS upgrade at all — see `src/starttls`.
 *
 * What is actually asserted, and why each one matters:
 *
 *   - the body arrives **after** the upgrade. Proves the message went over the
 *     encrypted channel rather than the client reporting success from replies
 *     it never really received.
 *   - EHLO, MAIL and RCPT are seen as TLS commands. Proves the writes issued
 *     immediately after `upgradeTLS()` were not dropped while the handshake was
 *     still in flight.
 *   - the server records no protocol error. Proves the reply buffer was not
 *     polluted with ciphertext from handlers left attached to the raw socket.
 *
 * A green "the client returned without throwing" is deliberately *not* the
 * assertion on its own. That is precisely the signal that lies when the buffer
 * is corrupt.
 */

import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sendMessage } from "../src/smtp/client/index.ts"

const PORT = 19_900 + Math.floor(Math.random() * 90)
const SERVER = new URL("./support/starttlsserver.py", import.meta.url).pathname

const dir = await mkdtemp(join(tmpdir(), "corsair-starttls-"))
let failed = false

try {
  await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
    -keyout ${join(dir, "key.pem")} -out ${join(dir, "cert.pem")} \
    -subj /CN=probe.invalid`.quiet()

  const verdictPath = join(dir, "verdict.json")
  const proc = Bun.spawn(
    ["python3", SERVER, join(dir, "cert.pem"), join(dir, "key.pem"), String(PORT), verdictPath],
    { stdout: "pipe", stderr: "pipe" },
  )

  // Wait for READY. Not a port probe — the server accepts exactly one
  // connection and a probe would consume the one the client needs.
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let out = ""
  const deadline = Date.now() + 20_000
  while (!out.includes("READY") && Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  reader.releaseLock()
  if (!out.includes("READY")) {
    throw new Error(`test server did not start: ${await new Response(proc.stderr).text()}`)
  }

  console.log(`probing 127.0.0.1:${PORT} through a real STARTTLS handshake…`)

  let clientError: string | null = null
  try {
    await sendMessage({
      host: "127.0.0.1",
      port: PORT,
      mailFrom: "probe@corsair.invalid",
      rcptTo: "probe@probe.invalid",
      raw: [
        "From: probe@corsair.invalid",
        "To: probe@probe.invalid",
        "Subject: STARTTLS regression",
        "",
        "STARTTLS-PROBE-BODY",
        "",
      ].join("\r\n"),
      timeoutMs: 20_000,
    })
  } catch (e) {
    clientError = (e as Error).message
  }

  // node:fs rather than Bun.file: Bun.file caches metadata from when the
  // reference was created, and this file is rewritten under us.
  type Verdict = {
    upgraded?: boolean
    body_after_upgrade?: boolean
    commands?: string[]
    error?: string
    finished?: boolean
  }

  const readVerdict = async (): Promise<Verdict | null> => {
    try {
      const text = await readFile(verdictPath, "utf8")
      return text.trim() ? JSON.parse(text) : null
    } catch {
      return null
    }
  }

  const until = Date.now() + 30_000
  let verdict = await readVerdict()
  while (Date.now() < until && !verdict?.finished) {
    await Bun.sleep(100)
    verdict = await readVerdict()
  }
  proc.kill()
  if (!verdict) throw new Error("test server wrote no verdict")

  const commands = verdict.commands ?? []
  const checks: [string, boolean][] = [
    ["client completed without error", clientError === null],
    ["server performed the TLS upgrade", verdict.upgraded === true],
    ["second EHLO arrived over TLS", commands.includes("tls:EHLO")],
    ["MAIL FROM arrived over TLS", commands.includes("tls:MAIL")],
    ["RCPT TO arrived over TLS", commands.includes("tls:RCPT")],
    ["message body arrived after the upgrade", verdict.body_after_upgrade === true],
    ["server saw no protocol error", verdict.error === undefined],
  ]

  for (const [label, ok] of checks) {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`)
    if (!ok) failed = true
  }
  console.log(`  sequence: ${commands.join(" → ")}`)
  if (clientError) console.log(`  client error: ${clientError}`)
  if (verdict.error) console.log(`  server error: ${verdict.error}`)
} catch (e) {
  failed = true
  console.error(`FAIL — ${(e as Error).message}`)
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(failed ? "\nSTARTTLS: FAIL" : "\nSTARTTLS: pass — nothing was delivered to anyone")
process.exit(failed ? 1 : 0)
