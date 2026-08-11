/**
 * Server-side STARTTLS against Corsair's real submission listener.
 *
 * The client side is covered by `tests/starttls.ts`. This is the other
 * direction: a mail client issuing STARTTLS to *us*.
 *
 * Two things are being tested, and the second is the one that bites.
 *
 * 1. The runtime can upgrade an accepted socket at all. Older builds throw
 *    "Server-side upgradeTLS is not supported" and the listener correctly does
 *    not advertise STARTTLS — so this reports SKIPPED rather than failing. A
 *    skip is printed loudly; a quiet skip is a test that lies.
 *
 * 2. **The post-upgrade stream is delivered to BOTH sockets.** Bun keeps
 *    feeding the encrypted bytes to the cleartext handler after the upgrade
 *    (oven-sh/bun#26297), so without the gate in each listener's `data` the
 *    session parses a TLS ClientHello as a command. Every command arrives
 *    twice. That is not a subtle failure — it corrupts the session — but it is
 *    invisible to any test that only checks the handshake completed.
 *
 * The verdict is whether commands sent *after* the upgrade are understood, not
 * whether the handshake returned.
 *
 *   bun tests/serverstarttls.ts
 *
 * Needs Postgres (`bun run db:up`): the listener checks the ban list on accept.
 */

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

let failures = 0

/** `hint` explains a failure and is printed only when there is one. */
const check = (label: string, ok: boolean, hint?: string) => {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`)
  if (!ok && hint) console.log(`        ${hint}`)
  if (!ok) failures++
}

/** Something worth seeing whether or not it failed. */
const note = (text: string) => console.log(`        ${text}`)

const dir = await mkdtemp(join(tmpdir(), "corsair-starttls-"))
const certPath = join(dir, "cert.pem")
const keyPath = join(dir, "key.pem")

const cleanup = async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

// A throwaway certificate. Generated rather than committed so nothing in the
// repository expires.
const openssl = Bun.spawnSync([
  "openssl",
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-keyout",
  keyPath,
  "-out",
  certPath,
  "-days",
  "1",
  "-nodes",
  "-subj",
  "/CN=localhost",
])
if (openssl.exitCode !== 0) {
  console.error("could not generate a test certificate; is openssl installed?")
  await cleanup()
  process.exit(1)
}

const port = 21000 + Math.floor(Math.random() * 20000)

const server = Bun.spawn(
  [
    // The running binary, not whatever `bun` resolves to on PATH. The whole
    // point is to test the capability of *this* runtime.
    process.execPath,
    "-e",
    `import { startSmtp } from ${JSON.stringify(new URL("../src/smtp/index.ts", import.meta.url).pathname)}
     import { startImap } from ${JSON.stringify(new URL("../src/imap/index.ts", import.meta.url).pathname)}
     import { startPop3 } from ${JSON.stringify(new URL("../src/pop3/index.ts", import.meta.url).pathname)}
     import { probeServerStartTls } from ${JSON.stringify(new URL("../src/starttls/index.ts", import.meta.url).pathname)}
     import { tlsOptions } from ${JSON.stringify(new URL("../src/tls/index.ts", import.meta.url).pathname)}
     const supported = await probeServerStartTls(await tlsOptions())
     await startSmtp()
     await startImap()
     await startPop3()
     console.log("READY " + (supported ? "yes" : "no"))`,
  ],
  {
    env: {
      ...process.env,
      TLS_CERT_PATH: certPath,
      TLS_KEY_PATH: keyPath,
      SMTP_SUBMISSION_PORT: String(port),
      SMTP_MX_PORT: String(port + 1),
      SMTP_SUBMISSION_TLS_PORT: String(port + 2),
      IMAP_PORT: String(port + 3),
      IMAP_TLS_PORT: String(port + 4),
      POP3_PORT: String(port + 5),
      POP3_TLS_PORT: String(port + 6),
    },
    stdout: "pipe",
    stderr: "pipe",
  },
)

/** The server announces itself; probing the port would consume an accept. */
const ready = async (): Promise<string> => {
  const reader = (server.stdout as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()
  let seen = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`server exited before READY:\n${seen}`)
    seen += decoder.decode(value, { stream: true })
    const match = seen.match(/READY (yes|no)/)
    if (match) {
      reader.releaseLock()
      return match[1] as string
    }
  }
}

const supported = await Promise.race([
  ready(),
  Bun.sleep(30_000).then(() => {
    throw new Error("the listener did not start within 30s")
  }),
]).catch(async (e) => {
  console.error(String(e))
  const err = await new Response(server.stderr as ReadableStream).text()
  if (err.trim()) console.error(err.slice(0, 2000))
  await cleanup()
  server.kill()
  process.exit(1)
})

if (supported === "no") {
  console.log("\nSKIPPED — this runtime cannot upgrade an accepted socket to TLS.")
  console.log("  STARTTLS is correctly not advertised; clients are pointed at 465/993/995.")
  console.log("  Re-run on a build where `socket.upgradeTLS({ isServer: true })` works.")
  server.kill()
  await cleanup()
  process.exit(0)
}

console.log(`probing 127.0.0.1:${port} with a real STARTTLS client…`)

const script = `
import smtplib, imaplib, poplib, ssl, json

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE
out = {}

# ---- SMTP submission -------------------------------------------------------
try:
    s = smtplib.SMTP("127.0.0.1", ${port}, timeout=20)
    smtp = {"advertised": bool(s.ehlo()[0] == 250 and s.has_extn("starttls"))}
    s.starttls(context=ctx)
    smtp["ehlo_after_upgrade"] = s.ehlo("probe.local")[0]
    # The session must survive the upgrade: AUTH is only advertised once the
    # connection is secure, so its presence proves the pre-upgrade state was
    # carried across rather than replaced by a fresh one.
    smtp["auth_offered"] = s.has_extn("auth")
    smtp["starttls_still_offered"] = s.has_extn("starttls")
    try:
        s.login("nobody@example.invalid", "wrong-password")
        smtp["auth"] = "unexpectedly succeeded"
    except smtplib.SMTPAuthenticationError as e:
        smtp["auth"] = f"refused {e.smtp_code}"
    except Exception as e:
        smtp["auth"] = f"{type(e).__name__}: {e}"
    smtp["cipher"] = s.sock.cipher()[0] if s.sock else None
    s.quit()
    smtp["ok"] = True
except Exception as e:
    smtp = {"ok": False, "error": f"{type(e).__name__}: {e}"}
out["smtp"] = smtp

# ---- IMAP ------------------------------------------------------------------
try:
    m = imaplib.IMAP4("127.0.0.1", ${port + 3})
    imap = {"advertised": "STARTTLS" in m.capabilities}
    m.starttls(ssl_context=ctx)
    typ, _ = m.capability()
    imap["capability_after_upgrade"] = typ
    try:
        m.login("nobody@example.invalid", "wrong-password")
        imap["auth"] = "unexpectedly succeeded"
    except imaplib.IMAP4.error as e:
        imap["auth"] = f"refused: {str(e)[:60]}"
    imap["ok"] = True
    try:
        m.logout()
    except Exception:
        pass
except Exception as e:
    imap = {"ok": False, "error": f"{type(e).__name__}: {e}"}
out["imap"] = imap

# ---- POP3 ------------------------------------------------------------------
try:
    p = poplib.POP3("127.0.0.1", ${port + 5}, timeout=20)
    caps = p.capa()
    pop = {"advertised": "STLS" in caps}
    p.stls(context=ctx)
    pop["capa_after_upgrade"] = "USER" in p.capa()
    try:
        p.user("nobody@example.invalid")
        p.pass_("wrong-password")
        pop["auth"] = "unexpectedly succeeded"
    except poplib.error_proto as e:
        pop["auth"] = f"refused: {str(e)[:60]}"
    pop["ok"] = True
    try:
        p.quit()
    except Exception:
        pass
except Exception as e:
    pop = {"ok": False, "error": f"{type(e).__name__}: {e}"}
out["pop3"] = pop

print(json.dumps(out))
`

const client = Bun.spawnSync(["python3", "-c", script])
const raw = new TextDecoder().decode(client.stdout).trim()
const stderr = new TextDecoder().decode(client.stderr).trim()

server.kill()
await cleanup()

let result: Record<string, unknown> = {}
try {
  result = JSON.parse(raw.split("\n").pop() ?? "{}")
} catch {
  console.error(`could not parse the client's verdict:\n${raw}\n${stderr}`)
  process.exit(1)
}

const smtp = (result.smtp ?? {}) as Record<string, unknown>
const imap = (result.imap ?? {}) as Record<string, unknown>
const pop3 = (result.pop3 ?? {}) as Record<string, unknown>

console.log("\nSMTP submission")
check("advertises STARTTLS", smtp.advertised === true)
check("the handshake completes", smtp.ok === true, smtp.error ? String(smtp.error) : undefined)
check(
  "EHLO after the upgrade is understood",
  smtp.ehlo_after_upgrade === 250,
  "a non-250 means the session was fed ciphertext — the gate is missing",
)
check(
  "the session survives the upgrade",
  smtp.auth_offered === true && smtp.starttls_still_offered === false,
  `AUTH offered=${String(smtp.auth_offered)}, STARTTLS still offered=${String(smtp.starttls_still_offered)} — both wrong means \`open\` ran again and replaced the session`,
)
check(
  "AUTH reaches the authenticator",
  typeof smtp.auth === "string" && smtp.auth.startsWith("refused"),
  `expected a refusal, got ${String(smtp.auth)}`,
)
note(String(smtp.auth))
check("a cipher was negotiated", typeof smtp.cipher === "string", "no cipher on the socket")
note(String(smtp.cipher))

console.log("\nIMAP")
check("advertises STARTTLS", imap.advertised === true)
check("the handshake completes", imap.ok === true, imap.error ? String(imap.error) : undefined)
check("CAPABILITY after the upgrade is understood", imap.capability_after_upgrade === "OK")
check(
  "LOGIN reaches the authenticator",
  typeof imap.auth === "string" && imap.auth.startsWith("refused"),
  `expected a refusal, got ${String(imap.auth)}`,
)
note(String(imap.auth))

console.log("\nPOP3")
check("advertises STLS", pop3.advertised === true)
check("the handshake completes", pop3.ok === true, pop3.error ? String(pop3.error) : undefined)
check("CAPA after the upgrade is understood", pop3.capa_after_upgrade === true)
check(
  "PASS reaches the authenticator",
  typeof pop3.auth === "string" && pop3.auth.startsWith("refused"),
  `expected a refusal, got ${String(pop3.auth)}`,
)
note(String(pop3.auth))

console.log(
  failures === 0
    ? `\nserver STARTTLS: pass on all three protocols — ${smtp.cipher}`
    : `\nserver STARTTLS: ${failures} failure(s)`,
)
process.exit(failures === 0 ? 0 : 1)
