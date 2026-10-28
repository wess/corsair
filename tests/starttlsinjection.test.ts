import { describe, expect, test } from "bun:test"
import { createImapSession } from "../src/imap/session/index.ts"
import { createPop3Session } from "../src/pop3/session/index.ts"
import { createSession } from "../src/smtp/session/index.ts"

/**
 * CVE-2011-0411: a man in the middle appends commands to the client's STARTTLS
 * in the same packet. They were sent in the clear, so the TLS session must
 * never see them. These listeners used to sit behind the terminator in
 * `engine/`, which refused them; facing the internet directly, each session
 * refuses them itself.
 */

const smtp = () => {
  let upgraded = 0
  const session = createSession({
    mode: "mx",
    hostname: "mx1.test",
    maxSize: 1024,
    remoteIp: "203.0.113.9",
    isSecure: () => false,
    startTls: () => {
      upgraded++
    },
    authenticate: async () => null,
    validateSender: async () => null,
    validateRecipient: async () => null,
    handleMessage: async () => ({ code: 250, message: "Queued." }),
  })
  return { session, upgraded: () => upgraded }
}

describe("SMTP", () => {
  test("a clean STARTTLS upgrades", async () => {
    const h = smtp()
    await h.session.feed("EHLO client.test\r\n")
    expect(await h.session.feed("STARTTLS\r\n")).toStartWith("220 ")
    expect(h.upgraded()).toBe(1)
    expect(h.session.shouldClose()).toBe(false)
  })

  test("commands pipelined behind STARTTLS close the connection without upgrading", async () => {
    const h = smtp()
    await h.session.feed("EHLO client.test\r\n")
    const out = await h.session.feed("STARTTLS\r\nMAIL FROM:<evil@attacker.test>\r\n")
    expect(out).toStartWith("220 ")
    expect(out).toContain("554 5.5.0")
    expect(out).not.toContain("250")
    expect(h.upgraded()).toBe(0)
    expect(h.session.shouldClose()).toBe(true)
  })

  test("replies to commands before STARTTLS in the same chunk still go out", async () => {
    const h = smtp()
    const out = await h.session.feed("EHLO client.test\r\nSTARTTLS\r\n")
    expect(out).toContain("250-STARTTLS")
    expect(out).toContain("220 2.0.0")
    expect(h.upgraded()).toBe(1)
  })
})

const imap = () => {
  let upgraded = 0
  const session = createImapSession({
    isSecure: () => false,
    startTls: () => {
      upgraded++
    },
    remoteIp: "203.0.113.9",
    push: () => {},
  })
  return { session, upgraded: () => upgraded }
}

describe("IMAP", () => {
  test("a clean STARTTLS upgrades", async () => {
    const h = imap()
    expect(await h.session.feed("a STARTTLS\r\n")).toContain("a OK")
    expect(h.upgraded()).toBe(1)
  })

  test("commands pipelined behind STARTTLS close the connection without upgrading", async () => {
    const h = imap()
    const out = await h.session.feed('a STARTTLS\r\nb LOGIN "victim" "pw"\r\n')
    expect(out).toContain("* BYE")
    expect(out).not.toContain("b ")
    expect(h.upgraded()).toBe(0)
    expect(h.session.shouldClose()).toBe(true)
  })
})

const pop3 = () => {
  let upgraded = 0
  const session = createPop3Session({
    isSecure: () => false,
    startTls: () => {
      upgraded++
    },
    remoteIp: "203.0.113.9",
  })
  return { session, upgraded: () => upgraded }
}

describe("POP3", () => {
  test("a clean STLS upgrades", async () => {
    const h = pop3()
    expect(await h.session.feed("STLS\r\n")).toStartWith("+OK")
    expect(h.upgraded()).toBe(1)
  })

  test("commands pipelined behind STLS close the connection without upgrading", async () => {
    const h = pop3()
    const out = await h.session.feed("STLS\r\nUSER victim\r\n")
    expect(out).toContain("-ERR")
    expect(out).not.toContain("Send PASS")
    expect(h.upgraded()).toBe(0)
    expect(h.session.shouldClose()).toBe(true)
  })
})
