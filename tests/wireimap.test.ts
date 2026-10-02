import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAddress, inboxOf } from "../src/addresses/index.ts"
import { db } from "../src/db/index.ts"
import { createListener } from "../src/imap/index.ts"
import { deliver } from "../src/store/index.ts"

/**
 * IMAP on a real TLS socket with a slow reader: what a mail client actually
 * receives. The session-level tests return strings and never see the wire, which
 * is how two bugs lived here unnoticed — a response larger than the socket buffer
 * was cut short, and every 8-bit byte went out re-encoded as UTF-8, so literals
 * were longer than the `{n}` that announced them.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `wire-${suffix}.invalid`
const password = "correct horse battery staple"

let userId = ""
let listener: ReturnType<typeof createListener>
let bigRaw = ""

const utf8 = (text: string) => Buffer.from(text, "utf8").toString("latin1")

const selfSigned = (): { cert: string; key: string } => {
  const dir = mkdtempSync(join(tmpdir(), "corsair-wire-"))
  const key = join(dir, "key.pem")
  const cert = join(dir, "cert.pem")
  const made = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-keyout",
    key,
    "-out",
    cert,
    "-subj",
    "/CN=localhost",
    "-days",
    "1",
  ])
  if (!made.success) throw new Error("openssl could not make a certificate")
  return { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") }
}

type Client = {
  send: (text: string) => void
  until: (marker: RegExp) => Promise<Buffer>
  close: () => void
}

const connect = async (delayMs = 0): Promise<Client> => {
  let buffer = Buffer.alloc(0)
  const waiting: (() => void)[] = []
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port: listener.port,
    tls: { rejectUnauthorized: false },
    socket: {
      async data(_s, chunk) {
        buffer = Buffer.concat([buffer, Buffer.from(chunk)])
        for (const w of waiting.splice(0)) w()
        if (delayMs) await Bun.sleep(delayMs)
      },
      open() {},
      close() {},
    },
  })
  return {
    send: (text) => void socket.write(text),
    async until(marker) {
      const started = Date.now()
      while (!marker.test(buffer.toString("latin1"))) {
        if (Date.now() - started > 30_000)
          throw new Error(
            `timed out waiting for ${marker}; had: ${buffer.toString("latin1").slice(0, 300)}`,
          )
        await new Promise<void>((resolve) => {
          waiting.push(resolve)
          setTimeout(resolve, 200)
        })
      }
      const out = buffer
      buffer = Buffer.alloc(0)
      return out
    },
    close: () => socket.end(),
  }
}

const login = async (client: Client) => {
  await client.until(/\* OK/)
  client.send(`a0 LOGIN alice@${zone} "${password}"\r\n`)
  await client.until(/a0 OK/)
  client.send("a1 SELECT INBOX\r\n")
  await client.until(/a1 OK/)
}

beforeAll(async () => {
  userId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Wire', $2) RETURNING id`,
    values: [`wire-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id
  const domain = (await db().one<{ id: string }>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=wire', 'active') RETURNING id`,
    values: [userId, zone],
  }))!
  const { address } = await createAddress({
    domainId: domain.id,
    localPart: "alice",
    type: "standard",
    password,
  })
  const inbox = await inboxOf(address.id)

  // Message 1: 3 MB of 8-bit UTF-8 stored as latin1, the way the pipeline holds it.
  const line = `${utf8("Grüße aus München — café €")}\r\n`
  let body = ""
  while (body.length < 3_000_000) body += line
  bigRaw = `From: sender@far.invalid\r\nTo: alice@${zone}\r\nSubject: big eight-bit\r\nMessage-ID: <big@far.invalid>\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`
  await deliver({ addressId: address.id, folderId: inbox.id, raw: bigRaw })

  // Message 2: small, with a word nothing else contains.
  await deliver({
    addressId: address.id,
    folderId: inbox.id,
    raw: `From: other@far.invalid\r\nTo: alice@${zone}\r\nSubject: small one\r\nMessage-ID: <small@far.invalid>\r\n\r\nthe word is zanzibar\r\n`,
  })

  listener = createListener({ port: 0, implicitTls: true, tls: selfSigned(), label: "wiretest" })
})

afterAll(async () => {
  listener?.stop(true)
  await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [userId] })
})

describe("IMAP on the wire", () => {
  test("a large 8-bit message is delivered intact, and its literal is the size announced", async () => {
    const client = await connect(1) // a slow reader, so the socket really does fill
    await login(client)
    client.send("a2 FETCH 1 BODY.PEEK[]\r\n")
    const wire = await client.until(/\r\na2 OK/)
    client.close()

    const text = wire.toString("latin1")
    const announced = /BODY\[\] \{(\d+)\}\r\n/.exec(text)
    expect(announced).not.toBeNull()
    const start = announced!.index + announced![0].length
    const size = Number(announced![1])

    // The literal is exactly the stored message, byte for byte: nothing cut, and
    // nothing re-encoded (which would have made it longer than `{n}`).
    const literal = wire.subarray(start, start + size)
    expect(size).toBe(bigRaw.length)
    expect(Buffer.compare(literal, Buffer.from(bigRaw, "latin1"))).toBe(0)
    expect(wire.subarray(start + size).toString("latin1")).toMatch(/^\)\r\na2 OK/)
  })

  test("pipelined commands are answered in order, even when one streams", async () => {
    const client = await connect()
    await login(client)
    client.send("b1 NOOP\r\nb2 FETCH 2 (UID FLAGS)\r\nb3 FETCH 1 BODY.PEEK[]\r\nb4 NOOP\r\n")
    const text = (await client.until(/\r\nb4 OK/)).toString("latin1")
    client.close()

    const at = (s: string) => text.indexOf(s)
    expect(at("b1 OK")).toBeGreaterThan(-1)
    expect(at("b1 OK")).toBeLessThan(at("b2 OK"))
    expect(at("b2 OK")).toBeLessThan(at("b3 OK"))
    expect(at("b3 OK")).toBeLessThan(at("b4 OK"))
    // The streamed message arrives before its own tagged reply, after b2's.
    expect(at("b2 OK")).toBeLessThan(at("BODY[]"))
  })

  test("SEARCH TEXT finds a message by its body without the extract on every row", async () => {
    const client = await connect()
    await login(client)
    client.send("c1 SEARCH TEXT zanzibar\r\n")
    const text = (await client.until(/c1 OK/)).toString("latin1")
    client.close()
    expect(text).toContain("* SEARCH 2\r\n")
  })

  test("SEARCH HEADER reads headers and finds the right message", async () => {
    const client = await connect()
    await login(client)
    client.send("d1 SEARCH HEADER Message-ID big@far.invalid\r\n")
    const text = (await client.until(/d1 OK/)).toString("latin1")
    client.send("d2 SEARCH NOT TEXT zanzibar\r\n")
    const negative = (await client.until(/d2 OK/)).toString("latin1")
    client.close()
    expect(text).toContain("* SEARCH 1\r\n")
    expect(negative).toContain("* SEARCH 1\r\n")
  })
})
