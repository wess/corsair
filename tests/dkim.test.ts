import { describe, expect, test } from "bun:test"
import { canonBody, dkimRecord, generateKeyPair, sign, verifySignature } from "../src/dkim/index.ts"
import { normalizeEol, parseMessage } from "../src/mime/index.ts"

const keys = generateKeyPair()
const lookup = async () => keys.record

const message = normalizeEol(
  [
    "From: Wess Cope <me@wess.io>",
    "To: someone@example.com",
    "Subject: Signed",
    "Date: Mon, 10 Aug 2026 12:00:00 +0000",
    "Message-ID: <1@wess.io>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Body text.   ",
    "",
    "",
  ].join("\n"),
)

describe("canonicalisation", () => {
  test("relaxed body collapses whitespace and trailing blank lines", () => {
    expect(canonBody("a  b \r\n\r\n\r\n")).toBe("a b\r\n")
  })

  test("an empty body canonicalises to the empty string", () => {
    expect(canonBody("")).toBe("")
    expect(canonBody("\r\n\r\n")).toBe("")
  })
})

describe("keys", () => {
  test("record carries a base64 SPKI key", () => {
    expect(keys.record).toStartWith("v=DKIM1; k=rsa; p=")
    expect(dkimRecord(keys.publicKey)).toBe(keys.record)
  })
})

describe("sign and verify", () => {
  test("a freshly signed message verifies", async () => {
    const signed = sign({
      raw: message,
      domain: "wess.io",
      selector: "corsair-1",
      privateKey: keys.privateKey,
    })
    const result = await verifySignature(signed, undefined, { lookup })
    expect(result.result).toBe("pass")
    expect(result.domain).toBe("wess.io")
    expect(result.selector).toBe("corsair-1")
  })

  test("the signature header lists only headers that exist", async () => {
    const signed = sign({
      raw: message,
      domain: "wess.io",
      selector: "corsair-1",
      privateKey: keys.privateKey,
    })
    const parsed = parseMessage(signed)
    const header = parsed.headers.find((h) => h.name.toLowerCase() === "dkim-signature")!
    // Anchored on a tag boundary so it does not match inside "bh=".
    const listed = header.value.match(/(?:^|;)\s*h=([^;]+)/)?.[1] ?? ""
    expect(listed.toLowerCase()).not.toContain("cc")
    expect(listed.toLowerCase()).toContain("from")
    expect(listed.toLowerCase()).toContain("subject")
  })

  test("tampering with the body fails the body hash", async () => {
    const signed = sign({
      raw: message,
      domain: "wess.io",
      selector: "corsair-1",
      privateKey: keys.privateKey,
    })
    const tampered = signed.replace("Body text.", "Different text.")
    const result = await verifySignature(tampered, undefined, { lookup })
    expect(result.result).toBe("fail")
    expect(result.reason).toContain("body hash")
  })

  test("tampering with a signed header fails the signature", async () => {
    const signed = sign({
      raw: message,
      domain: "wess.io",
      selector: "corsair-1",
      privateKey: keys.privateKey,
    })
    const tampered = signed.replace("Subject: Signed", "Subject: Forged")
    const result = await verifySignature(tampered, undefined, { lookup })
    expect(result.result).toBe("fail")
  })

  test("an unsigned message reports none", async () => {
    const result = await verifySignature(message, undefined, { lookup })
    expect(result.result).toBe("none")
  })

  test("adding an unsigned header does not break the signature", async () => {
    const signed = sign({
      raw: message,
      domain: "wess.io",
      selector: "corsair-1",
      privateKey: keys.privateKey,
    })
    // A relay prepending a Received header is the normal case and must not
    // invalidate anything.
    const relayed = `Received: from relay.example.com\r\n${signed}`
    const result = await verifySignature(relayed, undefined, { lookup })
    expect(result.result).toBe("pass")
  })
})
