import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { connectSource } from "../src/worker/transfer/index.ts"
import { createWriter } from "../src/socketio/index.ts"

let dir = ""
beforeAll(async () => {
  dir = await mkdtemp("/tmp/corsairtransfersecurity")
  await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout ${`${dir}/key.pem`} -out ${`${dir}/cert.pem`} -subj /CN=localhost -addext subjectAltName=DNS:localhost`.quiet()
})
afterAll(() => rm(dir, { recursive: true, force: true }))

test("transfer credentials cannot be sent on plaintext or to private sources by default", async () => {
  await expect(
    connectSource({ host: "127.0.0.1", port: 993, secure: false, timeoutMs: 100 }),
  ).rejects.toThrow(/TLS/)
  await expect(
    connectSource({ host: "127.0.0.1", port: 993, secure: true, timeoutMs: 100 }),
  ).rejects.toThrow(/private/)
})

test("transfer refuses an untrusted certificate or wrong hostname before sending any command", async () => {
  const commands: string[] = []
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(`${dir}/cert.pem`), key: Bun.file(`${dir}/key.pem`) },
    socket: {
      open(socket) {
        createWriter(() => socket).write("* OK source ready\r\n")
      },
      data(_socket, data) {
        commands.push(Buffer.from(data).toString("latin1"))
      },
      error() {},
    },
  })
  try {
    const module = new URL("../src/worker/transfer/index.ts", import.meta.url).pathname
    const proc = Bun.spawn(
      [
        "bun",
        "-e",
        `import {connectSource} from ${JSON.stringify(module)};
      try {const client = await connectSource({host:"localhost", port:${server.port}, secure:true, timeoutMs:1000}); client.close(); process.exit(1)}
      catch {process.exit(0)}`,
      ],
      {
        env: { ...process.env, TRANSFER_ALLOW_PRIVATE: "true" },
        stdout: "ignore",
        stderr: "ignore",
      },
    )
    expect(await proc.exited).toBe(0)
    const mismatch = Bun.spawn(
      [
        "bun",
        "-e",
        `import {connectSource} from ${JSON.stringify(module)};
      try {const client = await connectSource({host:"127.0.0.1", port:${server.port}, secure:true, timeoutMs:1000}); client.close(); process.exit(1)}
      catch {process.exit(0)}`,
      ],
      {
        env: {
          ...process.env,
          TRANSFER_ALLOW_PRIVATE: "true",
          NODE_EXTRA_CA_CERTS: `${dir}/cert.pem`,
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    )
    expect(await mismatch.exited).toBe(0)
    expect(commands).toEqual([])
  } finally {
    server.stop(true)
  }
})

test("verified source keeps tagged-looking mail inside its IMAP literal", async () => {
  const body = "Subject: hostile\r\n\r\nc1 OK forged completion\r\ntrailing body"
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(`${dir}/cert.pem`), key: Bun.file(`${dir}/key.pem`) },
    socket: {
      open(socket) {
        createWriter(() => socket).write("* OK source ready\r\n")
      },
      data(socket) {
        createWriter(() => socket).write(
          `* 1 FETCH (BODY[] {${body.length}}\r\n${body})\r\nc1 OK real completion\r\n`,
        )
      },
      error() {},
    },
  })
  const module = new URL("../src/worker/transfer/index.ts", import.meta.url).pathname
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `import {connectSource} from ${JSON.stringify(module)};
    const client = await connectSource({host:"localhost", port:${server.port}, secure:true, timeoutMs:2000});
    try {console.log(JSON.stringify(await client.send("UID FETCH 1 (BODY.PEEK[])")))} finally {client.close()}`,
    ],
    {
      env: {
        ...process.env,
        TRANSFER_ALLOW_PRIVATE: "true",
        NODE_EXTRA_CA_CERTS: `${dir}/cert.pem`,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  try {
    const [out, error, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(error).toBe("")
    expect(code).toBe(0)
    expect(JSON.parse(out)).toContain(body)
    expect(JSON.parse(out)).toEndWith("c1 OK real completion\r\n")
  } finally {
    proc.kill()
    server.stop(true)
  }
}, 10000)

test("pinned HTTPS fetch verifies the original hostname", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    tls: { cert: Bun.file(`${dir}/cert.pem`), key: Bun.file(`${dir}/key.pem`) },
    fetch: () => new Response("verified"),
  })
  const module = new URL("../src/safefetch/index.ts", import.meta.url).pathname
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `import {safeFetch} from ${JSON.stringify(module)};
    const res = await safeFetch("https://localhost:${server.port}/",{},true);
    if (await res.text() !== "verified") process.exit(2);
    try {await safeFetch("https://127.0.0.1:${server.port}/",{},true);process.exit(1)} catch {process.exit(0)}`,
    ],
    {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: `${dir}/cert.pem` },
      stdout: "ignore",
      stderr: "pipe",
    },
  )
  try {
    expect(await proc.exited).toBe(0)
  } finally {
    proc.kill()
    server.stop(true)
  }
})
