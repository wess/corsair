import { describe, expect, test } from "bun:test"
import {
  attachmentParts,
  bodyText,
  buildMessage,
  decodeWords,
  envelopeOf,
  findPart,
  headerValue,
  isSafeAddress,
  normalizeEol,
  parseAddressList,
  parseMessage,
  parseParams,
  searchTextOf,
  snippetOf,
  stripControls,
} from "../src/mime/index.ts"

const simple = normalizeEol(
  [
    "From: Wess Cope <me@wess.io>",
    "To: a@example.com, Bob <b@example.com>",
    "Subject: =?UTF-8?B?SGVsbG8g8J+Riw==?=",
    "Message-ID: <abc@wess.io>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hello there.",
    "Second line.",
  ].join("\n"),
)

const multipart = normalizeEol(
  [
    "From: a@example.com",
    "To: b@example.com",
    "Subject: With attachment",
    'Content-Type: multipart/mixed; boundary="BOUND"',
    "",
    "--BOUND",
    'Content-Type: multipart/alternative; boundary="ALT"',
    "",
    "--ALT",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "plain body",
    "--ALT",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>html body</p>",
    "--ALT--",
    "--BOUND",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    "SGVsbG8=",
    "--BOUND--",
  ].join("\n"),
)

describe("headers", () => {
  test("parses and unfolds", () => {
    const raw = normalizeEol("Subject: one\n  two\nTo: x@y.z\n\nbody")
    const msg = parseMessage(raw)
    expect(headerValue(msg.headers, "subject")).toBe("one two")
    expect(headerValue(msg.headers, "TO")).toBe("x@y.z")
  })

  test("decodes RFC 2047 words", () => {
    expect(decodeWords("=?UTF-8?B?SGVsbG8g8J+Riw==?=")).toBe("Hello 👋")
    expect(decodeWords("=?utf-8?Q?caf=C3=A9?=")).toBe("café")
  })

  test("joins adjacent encoded words without the separating space", () => {
    // A multi-byte character split across two words must survive reassembly.
    expect(decodeWords("=?utf-8?B?4pi=?= =?utf-8?B?uA==?=")).toBe("☸")
  })

  test("parses parameters including RFC 2231 continuations", () => {
    const { value, params } = parseParams(
      "attachment; filename*0*=utf-8''%E2%98%B8; filename*1*=%2Etxt",
    )
    expect(value).toBe("attachment")
    expect(params.filename).toBe("☸.txt")
  })
})

describe("stripControls", () => {
  test("removes CR and LF so a subject cannot inject a header", () => {
    const injected = "Hi\r\nBcc: attacker@evil.com"
    expect(stripControls(injected)).not.toContain("\r")
    expect(stripControls(injected)).not.toContain("\n")
  })

  test("survives a round trip through buildMessage", () => {
    const raw = buildMessage({
      from: { name: "A", address: "a@example.com" },
      to: [{ name: null, address: "b@example.com" }],
      subject: "Hi\r\nBcc: attacker@evil.com",
      text: "body",
      messageId: "<1@example.com>",
    })
    const msg = parseMessage(normalizeEol(raw))
    expect(headerValue(msg.headers, "bcc")).toBeNull()
  })
})

describe("addresses", () => {
  test("splits a list and pulls out display names", () => {
    const parsed = parseAddressList('"Cope, Wess" <me@wess.io>, b@example.com')
    expect(parsed).toEqual([
      { name: "Cope, Wess", address: "me@wess.io" },
      { name: null, address: "b@example.com" },
    ])
  })

  test("flattens group syntax", () => {
    const parsed = parseAddressList("Team: a@x.com, b@x.com;")
    expect(parsed.map((p) => p.address)).toEqual(["a@x.com", "b@x.com"])
  })
})

describe("structure", () => {
  test("reads a single-part message", () => {
    const msg = parseMessage(simple)
    expect(msg.root.type).toBe("text")
    expect(msg.root.subtype).toBe("plain")
    expect(msg.root.parts).toHaveLength(0)
    expect(bodyText(simple, msg).text.trim()).toBe("Hello there.\r\nSecond line.")
    expect(envelopeOf(msg).subject).toBe("Hello 👋")
    expect(envelopeOf(msg).to).toHaveLength(2)
  })

  test("walks nested multiparts and numbers sections", () => {
    const msg = parseMessage(multipart)
    expect(msg.root.type).toBe("multipart")
    expect(msg.root.parts).toHaveLength(2)
    expect(msg.root.parts[0]!.section).toBe("1")
    expect(msg.root.parts[0]!.parts.map((p) => p.section)).toEqual(["1.1", "1.2"])
    expect(msg.root.parts[1]!.section).toBe("2")

    const html = findPart(msg, "1.2")
    expect(html?.subtype).toBe("html")

    const { text, html: htmlBody } = bodyText(multipart, msg)
    expect(text.trim()).toBe("plain body")
    expect(htmlBody.trim()).toBe("<p>html body</p>")
  })

  test("finds attachments by disposition", () => {
    const parts = attachmentParts(parseMessage(multipart))
    expect(parts).toHaveLength(1)
    expect(parts[0]!.disposition?.params.filename).toBe("report.pdf")
  })

  test("body offsets are byte-exact", () => {
    const msg = parseMessage(simple)
    const body = simple.slice(msg.root.bodyStart, msg.root.end)
    expect(body).toBe("Hello there.\r\nSecond line.")
    expect(msg.root.size).toBe(body.length)
    expect(msg.root.lines).toBe(2)
  })

  test("snippet strips markup and collapses whitespace", () => {
    expect(snippetOf(multipart, parseMessage(multipart))).toBe("plain body")
  })
})

describe("isSafeAddress", () => {
  const safe = (value: string) => isSafeAddress(value)

  test("accepts ordinary addresses", () => {
    expect(safe("someone@example.com")).toBe(true)
    expect(safe("first.last+tag@sub.example.co.uk")).toBe(true)
  })

  test("refuses anything that would end the command or start another", () => {
    expect(safe("a@b.test>\r\nRSET")).toBe(false)
    expect(safe("a@b.test\nMAIL FROM:<x@y.test>")).toBe(false)
    expect(safe("a@b.test>")).toBe(false)
    expect(safe("a b@c.test")).toBe(false)
    expect(safe("a@b.test\0")).toBe(false)
  })

  test("refuses what is not an address", () => {
    expect(safe("")).toBe(false)
    expect(safe("nobody")).toBe(false)
    expect(safe("@b.test")).toBe(false)
    expect(safe("a@@b.test")).toBe(false)
    expect(safe(`${"a".repeat(320)}@b.test`)).toBe(false)
  })
})

describe("normalizeEol", () => {
  test("rewrites bare LF and bare CR, and leaves CRLF alone", () => {
    expect(normalizeEol("a\nb\rc\r\nd")).toBe("a\r\nb\r\nc\r\nd")
    expect(normalizeEol("\nx")).toBe("\r\nx")
    expect(normalizeEol("x\r")).toBe("x\r\n")
    expect(normalizeEol("\r\n\r\n")).toBe("\r\n\r\n")
    expect(normalizeEol("")).toBe("")
  })

  test("returns the very same string when there is nothing to do", () => {
    const clean = "Subject: x\r\n\r\nbody\r\nmore\r\n"
    expect(normalizeEol(clean)).toBe(clean)
  })
})

describe("snippetOf and searchTextOf on a large body", () => {
  const body = "The quick brown fox jumps over the lazy dog.\r\n".repeat(200_000)
  const raw = `From: a@b.invalid\r\nSubject: Large é\r\nContent-Type: text/plain\r\n\r\n${body}`
  const parsed = parseMessage(raw)

  test("the snippet is the start of the text, whitespace collapsed", () => {
    expect(snippetOf(raw, parsed)).toBe(
      `${"The quick brown fox jumps over the lazy dog. ".repeat(6)}`.trim().slice(0, 240),
    )
  })

  test("the search extract is bounded and starts with the headers", () => {
    const text = searchTextOf(raw, parsed)
    expect(text.length).toBeLessThanOrEqual(100_000)
    expect(text.startsWith("Large")).toBe(true)
    expect(text).toContain("quick brown fox")
  })

  test("a base64 body is decoded from its start", () => {
    const encoded = Buffer.from("alpha beta gamma ".repeat(100_000))
      .toString("base64")
      .replace(/(.{76})/g, "$1\r\n")
    const message = `Subject: s\r\nContent-Type: text/plain\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}\r\n`
    expect(snippetOf(message, parseMessage(message))).toStartWith("alpha beta gamma alpha")
  })
})

test("deeply nested attached messages stay within the parser depth budget", () => {
  const raw = `${"Content-Type: message/rfc822\r\n\r\n".repeat(5000)}Subject: leaf\r\n\r\nbody`
  let part = parseMessage(raw).root
  let depth = 0
  while (part.child) {
    depth++
    part = part.child.root
  }
  expect(depth).toBeLessThanOrEqual(32)
  expect(part.size).toBeGreaterThan(0)
})

test("a multipart message cannot allocate an unlimited part tree", () => {
  const raw =
    'Content-Type: multipart/mixed; boundary="b"\r\n\r\n' +
    "--b\r\nContent-Type: text/plain\r\n\r\nx\r\n".repeat(5000) +
    "--b--\r\n"
  expect(parseMessage(raw).root.parts.length).toBeLessThan(1000)
})
