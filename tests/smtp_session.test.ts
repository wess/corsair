import { describe, expect, test } from "bun:test"
import {
  createSession,
  type Envelope,
  type Identity,
  type SessionHooks,
} from "../src/smtp/session/index.ts"

type Captured = { envelope: Envelope; raw: string; identity: Identity | null }

const harness = (over: Partial<SessionHooks> = {}) => {
  const delivered: Captured[] = []
  let secure = false
  let upgraded = false

  const hooks: SessionHooks = {
    mode: "mx",
    hostname: "mx1.test",
    maxSize: 1024,
    remoteIp: "203.0.113.9",
    isSecure: () => secure,
    startTls: () => {
      upgraded = true
      secure = true
    },
    authenticate: async (username, password) =>
      username === "me@wess.io" && password === "hunter2" ? { username, id: "addr-1" } : null,
    validateSender: async () => null,
    validateRecipient: async () => null,
    handleMessage: async (envelope, raw, identity) => {
      delivered.push({ envelope, raw, identity })
      return { code: 250, enhanced: "2.0.0", message: "Queued." }
    },
    ...over,
  }

  const session = createSession(hooks)
  return {
    session,
    delivered,
    get upgraded() {
      return upgraded
    },
    setSecure: (value: boolean) => {
      secure = value
    },
    send: (...lines: string[]) => session.feed(`${lines.join("\r\n")}\r\n`),
  }
}

describe("greeting and EHLO", () => {
  test("greets with the configured hostname", () => {
    const { session } = harness()
    expect(session.greeting()).toBe("220 mx1.test ESMTP Corsair\r\n")
  })

  test("EHLO advertises the extensions", async () => {
    const h = harness()
    const out = await h.send("EHLO client.test")
    expect(out).toContain("250-SIZE 1024")
    expect(out).toContain("250-8BITMIME")
    expect(out).toContain("250-PIPELINING")
    expect(out).toContain("250-STARTTLS")
    expect(out.trimEnd().split("\r\n").pop()).toStartWith("250 ")
  })

  test("EHLO without a domain is a syntax error", async () => {
    const h = harness()
    expect(await h.send("EHLO")).toStartWith("501 ")
  })

  test("MAIL before EHLO is refused", async () => {
    const h = harness()
    expect(await h.send("MAIL FROM:<a@b.test>")).toStartWith("503 ")
  })
})

describe("AUTH", () => {
  test("is not advertised or accepted in the clear", async () => {
    const h = harness()
    const out = await h.send("EHLO client.test")
    expect(out).not.toContain("AUTH")
    expect(await h.send("AUTH PLAIN")).toStartWith("538 ")
  })

  test("PLAIN with an initial response succeeds over TLS", async () => {
    const h = harness()
    h.setSecure(true)
    await h.send("EHLO client.test")
    const payload = Buffer.from("\0me@wess.io\0hunter2").toString("base64")
    expect(await h.send(`AUTH PLAIN ${payload}`)).toStartWith("235 ")
  })

  test("PLAIN with a bad password fails", async () => {
    const h = harness()
    h.setSecure(true)
    await h.send("EHLO client.test")
    const payload = Buffer.from("\0me@wess.io\0wrong").toString("base64")
    expect(await h.send(`AUTH PLAIN ${payload}`)).toStartWith("535 ")
  })

  test("LOGIN walks through both prompts", async () => {
    const h = harness()
    h.setSecure(true)
    await h.send("EHLO client.test")

    const first = await h.send("AUTH LOGIN")
    expect(first).toStartWith("334 ")
    expect(Buffer.from(first.slice(4).trim(), "base64").toString()).toBe("Username:")

    const second = await h.send(Buffer.from("me@wess.io").toString("base64"))
    expect(Buffer.from(second.slice(4).trim(), "base64").toString()).toBe("Password:")

    expect(await h.send(Buffer.from("hunter2").toString("base64"))).toStartWith("235 ")
  })

  test("a client can cancel with *", async () => {
    const h = harness()
    h.setSecure(true)
    await h.send("EHLO client.test")
    await h.send("AUTH LOGIN")
    expect(await h.send("*")).toStartWith("501 ")
  })
})

describe("STARTTLS", () => {
  test("upgrades and discards the pre-TLS greeting", async () => {
    const h = harness()
    await h.send("EHLO client.test")
    expect(await h.send("STARTTLS")).toStartWith("220 ")
    expect(h.upgraded).toBe(true)

    h.session.resetAfterTls()
    // The session forgot the EHLO, so a transaction cannot resume across it.
    expect(await h.send("MAIL FROM:<a@b.test>")).toStartWith("503 ")
  })
})

describe("transaction", () => {
  const open = async () => {
    const h = harness()
    await h.send("EHLO client.test")
    return h
  }

  test("accepts a complete message", async () => {
    const h = await open()
    expect(await h.send("MAIL FROM:<a@b.test>")).toStartWith("250 ")
    expect(await h.send("RCPT TO:<me@wess.io>")).toStartWith("250 ")
    expect(await h.send("DATA")).toStartWith("354 ")
    const out = await h.send("Subject: Hi", "", "Body line.", ".")
    expect(out).toStartWith("250 ")

    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]!.envelope.mailFrom).toBe("a@b.test")
    expect(h.delivered[0]!.envelope.rcptTo).toEqual(["me@wess.io"])
    expect(h.delivered[0]!.raw).toBe("Subject: Hi\r\n\r\nBody line.\r\n")
  })

  test("un-stuffs a leading dot", async () => {
    const h = await open()
    await h.send("MAIL FROM:<a@b.test>", "RCPT TO:<me@wess.io>", "DATA")
    await h.send("", "..hidden", "normal", ".")
    expect(h.delivered[0]!.raw).toContain("\r\n.hidden\r\n")
  })

  test("accepts an empty MAIL FROM for a bounce", async () => {
    const h = await open()
    expect(await h.send("MAIL FROM:<>")).toStartWith("250 ")
  })

  test("strips a source route", async () => {
    const h = await open()
    await h.send("MAIL FROM:<@relay.test:real@sender.test>")
    await h.send("RCPT TO:<me@wess.io>", "DATA", ".")
    expect(h.delivered[0]!.envelope.mailFrom).toBe("real@sender.test")
  })

  test("records a declared SIZE and refuses one over the limit", async () => {
    const h = await open()
    expect(await h.send("MAIL FROM:<a@b.test> SIZE=99999")).toStartWith("552 ")
    expect(await h.send("MAIL FROM:<a@b.test> SIZE=100")).toStartWith("250 ")
  })

  test("refuses DATA with no recipients", async () => {
    const h = await open()
    await h.send("MAIL FROM:<a@b.test>")
    expect(await h.send("DATA")).toStartWith("554 ")
  })

  test("RSET clears the transaction", async () => {
    const h = await open()
    await h.send("MAIL FROM:<a@b.test>")
    expect(await h.send("RSET")).toStartWith("250 ")
    expect(await h.send("DATA")).toStartWith("503 ")
  })

  test("rejects a message that runs past the size limit", async () => {
    const h = await open()
    await h.send("MAIL FROM:<a@b.test>", "RCPT TO:<me@wess.io>", "DATA")
    const long = "x".repeat(600)
    const out = await h.send(long, long, long, ".")
    expect(out).toStartWith("552 ")
    expect(h.delivered).toHaveLength(0)
  })

  test("a rejected recipient does not enter the envelope", async () => {
    const h = harness({
      validateRecipient: async (address) =>
        address === "nope@wess.io"
          ? { code: 550, enhanced: "5.1.1", message: "No such user." }
          : null,
    })
    await h.send("EHLO client.test")
    await h.send("MAIL FROM:<a@b.test>")
    expect(await h.send("RCPT TO:<nope@wess.io>")).toStartWith("550 ")
    expect(await h.send("RCPT TO:<me@wess.io>")).toStartWith("250 ")
    await h.send("DATA", ".")
    expect(h.delivered[0]!.envelope.rcptTo).toEqual(["me@wess.io"])
  })
})

describe("pipelining and framing", () => {
  test("handles several commands in one packet", async () => {
    const h = harness()
    const out = await h.session.feed(
      "EHLO client.test\r\nMAIL FROM:<a@b.test>\r\nRCPT TO:<me@wess.io>\r\nDATA\r\n",
    )
    expect(out).toContain("250-SIZE")
    expect(out).toContain("354 ")
  })

  test("handles a command split across packets", async () => {
    const h = harness()
    await h.session.feed("EHLO cli")
    const out = await h.session.feed("ent.test\r\n")
    expect(out).toContain("250-SIZE")
  })

  test("tolerates a bare LF", async () => {
    const h = harness()
    expect(await h.session.feed("EHLO client.test\n")).toContain("250-SIZE")
  })
})

describe("abuse", () => {
  test("drops the connection after too many bad commands", async () => {
    const h = harness()
    let out = ""
    for (let i = 0; i < 10; i++) out = await h.send("BOGUS")
    expect(out).toStartWith("421 ")
    expect(h.session.shouldClose()).toBe(true)
  })

  test("VRFY never confirms an address", async () => {
    const h = harness()
    await h.send("EHLO client.test")
    expect(await h.send("VRFY me@wess.io")).toStartWith("252 ")
  })

  test("QUIT closes", async () => {
    const h = harness()
    expect(await h.send("QUIT")).toStartWith("221 ")
    expect(h.session.shouldClose()).toBe(true)
  })
})

describe("the null reverse-path", () => {
  /**
   * `MAIL FROM:<>` is mandatory, not exotic. RFC 5321 §4.5.5 requires it on
   * every delivery status notification, so a server that cannot accept it
   * cannot receive a bounce from anybody — not from Gmail, not from its own
   * queue.
   *
   * The bug this pins down was worse than a flat rejection: MAIL FROM:<> was
   * answered **250**, and then the RCPT that followed got
   * "503 Send MAIL FROM first". The envelope used `mailFrom: ""` as the
   * sentinel for "no transaction yet", and the null reverse-path legitimately
   * *is* the empty string. Found by sending a real bounce that the server then
   * refused to accept from itself.
   */
  test("MAIL FROM:<> begins a transaction that RCPT can continue", async () => {
    const h = harness()
    await h.send("EHLO probe.test")

    const mail = await h.send("MAIL FROM:<>")
    expect(mail).toContain("250")

    const rcpt = await h.send("RCPT TO:<someone@mx1.test>")
    expect(rcpt).not.toContain("503")
    expect(rcpt).toContain("250")
  })

  test("a bounce can be delivered end to end", async () => {
    const h = harness()
    await h.send("EHLO probe.test")
    await h.send("MAIL FROM:<>")
    await h.send("RCPT TO:<someone@mx1.test>")
    await h.send("DATA")

    const done = await h.send(
      "From: Mail Delivery System <postmaster@elsewhere.test>",
      "To: <someone@mx1.test>",
      "Subject: Undelivered Mail Returned to Sender",
      "",
      "Your message could not be delivered.",
      ".",
    )
    expect(done).toContain("250")
    expect(h.delivered).toHaveLength(1)
    expect(h.delivered[0]?.envelope.mailFrom).toBe("")
    expect(h.delivered[0]?.envelope.hasSender).toBe(true)
  })

  test("RCPT with no MAIL FROM at all is still refused", async () => {
    const h = harness()
    await h.send("EHLO probe.test")
    // The guard still has to work; the fix was to stop conflating "empty
    // address" with "no command yet".
    expect(await h.send("RCPT TO:<someone@mx1.test>")).toContain("503")
  })

  test("a second MAIL FROM after a null one is refused", async () => {
    const h = harness()
    await h.send("EHLO probe.test")
    await h.send("MAIL FROM:<>")
    expect(await h.send("MAIL FROM:<other@probe.test>")).toContain("503")
  })
})
