import { describe, expect, test } from "bun:test"
import { isReputationBlock, sendMessage } from "../src/smtp/client/index.ts"

/**
 * A blocklisted sending IP must defer, not bounce.
 *
 * This is the failure this server actually hit: a receiver answered
 * `554 5.7.1 ... blocked using zen.spamhaus.org` at the greeting, the client
 * read a 5xx, and the queue bounced the message. The listing was an operator
 * problem with a fix measured in hours; every message sent in the meantime was
 * destroyed and its sender told delivery had failed permanently.
 *
 * The rule is narrow on purpose and both halves are load-bearing:
 *
 *   - **before a recipient is named** — everything up to MAIL FROM is the
 *     remote's opinion of *us*. After RCPT it may be about the recipient, and a
 *     "no such user" that happens to mention a blocklist must still bounce.
 *   - **the text names a blocklist** — otherwise a genuine permanent rejection
 *     of the sender domain would be retried for a week before the sender heard
 *     anything.
 *
 * Needs no database: it talks to a socket it starts itself.
 */

/** A one-shot SMTP server that fails at a chosen point with a chosen reply. */
const rejectingServer = async (input: { at: "greeting" | "mail" | "rcpt"; reply: string }) => {
  const server = Bun.listen<undefined>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        if (input.at === "greeting") {
          socket.write(`${input.reply}\r\n`)
          return
        }
        socket.write("220 fake.invalid ESMTP\r\n")
      },
      data(socket, raw) {
        const line = Buffer.from(raw).toString("latin1")
        if (/^EHLO/i.test(line)) {
          socket.write("250-fake.invalid\r\n250 SIZE 52428800\r\n")
          return
        }
        if (/^MAIL FROM/i.test(line)) {
          socket.write(`${input.at === "mail" ? input.reply : "250 2.1.0 ok"}\r\n`)
          return
        }
        if (/^RCPT TO/i.test(line)) {
          socket.write(`${input.at === "rcpt" ? input.reply : "250 2.1.5 ok"}\r\n`)
          return
        }
        if (/^QUIT/i.test(line)) socket.write("221 2.0.0 bye\r\n")
      },
    },
  })
  return {
    port: server.port,
    stop: () => server.stop(true),
  }
}

const attempt = async (at: "greeting" | "mail" | "rcpt", reply: string) => {
  const server = await rejectingServer({ at, reply })
  try {
    return await sendMessage({
      host: "127.0.0.1",
      port: server.port,
      mailFrom: "probe@corsair.invalid",
      rcptTo: "someone@example.invalid",
      raw: "Subject: probe\r\n\r\nbody\r\n",
      timeoutMs: 5_000,
    })
  } finally {
    server.stop()
  }
}

describe("recognising a rejection of the sending host", () => {
  test("names the blocklists that actually answer this way", () => {
    // The exact reply this server was given in production.
    expect(
      isReputationBlock(
        "5.7.1 Service unavailable; Client host [159.65.39.22] blocked using zen.spamhaus.org; Listed by PBL",
      ),
    ).toBe(true)
    expect(isReputationBlock("5.7.1 Your IP is on a blocklist")).toBe(true)
    expect(isReputationBlock("Rejected by Barracudacentral")).toBe(true)
  })

  test("does not fire on an ordinary permanent rejection", () => {
    expect(
      isReputationBlock("5.1.1 The email account that you tried to reach does not exist"),
    ).toBe(false)
    expect(isReputationBlock("5.2.2 Mailbox full")).toBe(false)
    expect(isReputationBlock("5.7.1 Message rejected as spam")).toBe(false)
  })
})

describe("a blocklist rejection before the recipient is named", () => {
  test("at the greeting, defers", async () => {
    const result = await attempt(
      "greeting",
      "554 5.7.1 Service unavailable; Client host [159.65.39.22] blocked using zen.spamhaus.org",
    )

    expect(result.ok).toBe(false)
    expect(result.code).toBe(554)
    // The whole point: the queue keeps this message and sends it on delisting.
    expect(result.retryable).toBe(true)
  })

  test("at MAIL FROM, defers", async () => {
    const result = await attempt("mail", "550 5.7.1 Sending IP listed by Spamhaus PBL")
    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
  })
})

describe("everything else still bounces", () => {
  test("an unknown recipient is permanent even if the text says blocklist", async () => {
    // After RCPT the rejection may genuinely be about the recipient. Retrying
    // this for a week would delay the bounce the sender needs to see.
    const result = await attempt("rcpt", "550 5.1.1 No such user; not on any blocklist")
    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(false)
  })

  test("a plain permanent rejection at the greeting is still permanent", async () => {
    const result = await attempt("greeting", "554 5.7.1 Service unavailable")
    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(false)
  })

  test("a 4xx is retryable as it always was", async () => {
    const result = await attempt("mail", "451 4.3.0 Try again later")
    expect(result.ok).toBe(false)
    expect(result.retryable).toBe(true)
  })
})
