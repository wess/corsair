import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { from } from "@wess/atlas/db/query"
import { createAddress } from "../src/addresses/index.ts"
import { db } from "../src/db/index.ts"
import { listenManageSieve } from "../src/managesieve/index.ts"
import { type Domain, users } from "../src/schema/index.ts"

/**
 * ManageSieve over a real socket: framing, a literal split across writes, and a
 * script whose octets and characters differ. Session tests hand strings back
 * and never touch the wire. TLS here is implicit — the upgrade path is shared
 * with the other listeners and covered by `bun run test:starttls:server`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const domainName = `wsv-${suffix}.invalid`
const email = `box@${domainName}`
const password = "hunter2hunter2"
let userId = ""
let tls: { cert: string; key: string } | null = null

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "sieve-"))
  const made =
    await Bun.$`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout ${dir}/key.pem -out ${dir}/cert.pem -subj /CN=localhost`
      .quiet()
      .nothrow()
  if (made.exitCode === 0) {
    tls = {
      cert: readFileSync(`${dir}/cert.pem`, "utf8"),
      key: readFileSync(`${dir}/key.pem`, "utf8"),
    }
  }

  const user = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, $2, 'Wire', $3) RETURNING id`,
    values: [email, await Bun.password.hash(password), `w${suffix}`],
  })
  userId = user!.id
  const domain = await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=test', 'active') RETURNING *`,
    values: [userId, domainName],
  })
  await createAddress({
    domainId: domain!.id,
    localPart: "box",
    type: "standard",
    ownerId: userId,
  } as never)
})

afterAll(async () => {
  await db().execute(
    from(users)
      .where((q) => q("id").equals(userId))
      .del(),
  )
})

const connect = async (port: number, secure: boolean) => {
  let received = Buffer.alloc(0)
  let wake: (() => void) | null = null
  const socket = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    ...(secure ? { tls: { rejectUnauthorized: false } } : {}),
    socket: {
      data(_s, chunk) {
        received = Buffer.concat([received, chunk])
        wake?.()
      },
      open() {},
    },
  })
  const until = async (done: (text: string) => boolean): Promise<string> => {
    const deadline = Date.now() + 5_000
    while (!done(received.toString("latin1"))) {
      if (Date.now() > deadline) throw new Error(`timed out; got ${received.toString("latin1")}`)
      await new Promise<void>((resolve) => {
        wake = resolve
        setTimeout(resolve, 50)
      })
    }
    const text = received.toString("latin1")
    received = Buffer.alloc(0)
    return text
  }
  return {
    until,
    reply: () => until((t) => /^(OK|NO|BYE)\b.*\r\n$/m.test(t) && t.endsWith("\r\n")),
    write: (data: string | Buffer) =>
      socket.write(typeof data === "string" ? Buffer.from(data, "latin1") : data),
    close: () => socket.end(),
  }
}

describe("over a real socket", () => {
  test("plaintext listener greets, and refuses PLAIN", async () => {
    const server = listenManageSieve({ port: 0, hostname: "127.0.0.1", tls: null })
    try {
      const c = await connect(server.port, false)
      const banner = await c.until((t) => /\r\nOK /.test(t) || t.startsWith("OK"))
      expect(banner).toContain('"IMPLEMENTATION" "Corsair"')
      expect(banner).toContain('"SASL" ""')
      c.write(
        `AUTHENTICATE "PLAIN" "${Buffer.from(`\0${email}\0${password}`).toString("base64")}"\r\n`,
      )
      expect(await c.reply()).toStartWith("NO (ENCRYPT-NEEDED)")
      c.write("LOGOUT\r\n")
      expect(await c.reply()).toStartWith("OK")
      c.close()
    } finally {
      server.stop(true)
    }
  })

  test("a large UTF-8 script survives a split write and comes back byte for byte", async () => {
    if (!tls) {
      console.warn("SKIPPED: openssl is unavailable")
      return
    }
    const server = listenManageSieve({
      port: 0,
      hostname: "127.0.0.1",
      implicitTls: true,
      tls,
    })
    try {
      const c = await connect(server.port, true)
      await c.until((t) => /OK /.test(t))
      c.write(
        `AUTHENTICATE "PLAIN" "${Buffer.from(`\0${email}\0${password}`).toString("base64")}"\r\n`,
      )
      expect(await c.reply()).toStartWith("OK")

      // Multi-byte characters make the octet count differ from the length.
      const script = `# ${"café über ".repeat(3000)}\nkeep;\n`
      const bytes = Buffer.from(script)
      expect(bytes.length).toBeLessThan(64_000)
      expect(bytes.length).not.toBe(script.length)

      const head = Buffer.from(`PUTSCRIPT "big" {${bytes.length}+}\r\n`, "latin1")
      const whole = Buffer.concat([head, bytes, Buffer.from("\r\n")])
      c.write(whole.subarray(0, 20_001))
      await new Promise((r) => setTimeout(r, 50))
      c.write(whole.subarray(20_001))
      expect(await c.reply()).toStartWith("OK")

      c.write('GETSCRIPT "big"\r\n')
      const got = await c.until((t) => t.endsWith('OK "Getscript completed."\r\n'))
      const raw = Buffer.from(got, "latin1")
      const prefix = Buffer.from(`{${bytes.length}}\r\n`, "latin1")
      expect(raw.subarray(0, prefix.length).equals(prefix)).toBe(true)
      expect(raw.subarray(prefix.length, prefix.length + bytes.length).equals(bytes)).toBe(true)

      const row = await db().one<{ script: string }>({
        text: "SELECT script FROM filters WHERE user_id = $1 AND name = 'big'",
        values: [userId],
      })
      expect(row?.script).toBe(script)

      c.write('SETACTIVE "big"\r\nLISTSCRIPTS\r\nLOGOUT\r\n')
      const tail = await c.until((t) => t.endsWith('OK "Logout completed."\r\n'))
      expect(tail).toContain('"big" ACTIVE\r\n')
      c.close()
    } finally {
      server.stop(true)
    }
  })

  test("an oversized literal before login ends the connection", async () => {
    const server = listenManageSieve({ port: 0, hostname: "127.0.0.1", tls: null })
    try {
      const c = await connect(server.port, false)
      await c.until((t) => /OK /.test(t))
      c.write("AUTHENTICATE {100000+}\r\n")
      expect(await c.until((t) => t.includes("BYE"))).toContain("BYE")
      c.close()
    } finally {
      server.stop(true)
    }
  })
})
