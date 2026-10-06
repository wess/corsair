import { expect, test } from "bun:test"
import { sendMessage } from "../src/smtp/client/index.ts"
import { createWriter } from "../src/socketio/index.ts"

test("an authenticated relay receives no credential on plaintext SMTP", async () => {
  const commands: string[] = []
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        createWriter(() => socket).write("220 relay.test ready\r\n")
      },
      data(socket, data) {
        const line = Buffer.from(data).toString("latin1")
        commands.push(line)
        if (line.startsWith("EHLO"))
          createWriter(() => socket).write("250-relay.test\r\n250 AUTH PLAIN\r\n")
      },
    },
  })
  try {
    const result = await sendMessage({
      host: "127.0.0.1",
      port: server.port,
      auth: { user: "mailbox", pass: "secret" },
      mailFrom: "sender@example.invalid",
      rcptTo: "recipient@example.invalid",
      raw: "Subject: probe\r\n\r\nbody\r\n",
      timeoutMs: 1000,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("TLS")
    expect(commands.some((line) => line.startsWith("AUTH"))).toBe(false)
  } finally {
    server.stop(true)
  }
})

test("an authenticated relay refuses an untrusted STARTTLS certificate", async () => {
  const dir = await import("node:fs/promises").then((fs) => fs.mkdtemp("/tmp/corsairrelaysecurity"))
  let proc: ReturnType<typeof Bun.spawn> | undefined
  try {
    await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout ${`${dir}/key.pem`} -out ${`${dir}/cert.pem`} -subj /CN=probe.invalid`.quiet()
    const server = new URL("./support/starttlsserver.py", import.meta.url).pathname
    proc = Bun.spawn(
      ["python3", server, `${dir}/cert.pem`, `${dir}/key.pem`, "0", `${dir}/verdict.json`],
      { stdout: "pipe", stderr: "pipe" },
    )
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    const { value } = await reader.read()
    const port = Number(new TextDecoder().decode(value).match(/READY (\d+)/)?.[1])
    reader.releaseLock()
    expect(port).toBeGreaterThan(0)
    const result = await sendMessage({
      host: "127.0.0.1",
      port,
      auth: { user: "mailbox", pass: "secret" },
      mailFrom: "sender@example.invalid",
      rcptTo: "recipient@example.invalid",
      raw: "Subject: probe\r\n\r\nbody\r\n",
      timeoutMs: 2000,
    })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("TLS")
    await proc.exited
    const seen = await Bun.file(`${dir}/verdict.json`).json()
    expect(seen.commands.some((command: string) => command.includes("AUTH"))).toBe(false)
  } finally {
    proc?.kill()
    await import("node:fs/promises").then((fs) => fs.rm(dir, { recursive: true, force: true }))
  }
}, 15000)
