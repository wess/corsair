import { describe, expect, test } from "bun:test"
import {
  canonBody,
  dkimRecord,
  generateKeyPair,
  reassembleTxt,
  sign,
  verifySignature,
} from "../src/dkim/index.ts"
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

describe("resolver shape and malformed keys", () => {
  // A TXT string cannot exceed 255 bytes, so every 2048-bit key is published as
  // several strings. Node hands them back as one record with several chunks;
  // Bun 1.3 hands each string back as its own record. Both must reassemble.
  test("reassembles a key split the way Node reports it", () => {
    const record = keys.record
    const a = record.slice(0, 255)
    const b = record.slice(255)
    expect(reassembleTxt([[a, b]])).toBe(record)
  })

  test("reassembles a key split the way Bun reports it", () => {
    const record = keys.record
    const a = record.slice(0, 255)
    const b = record.slice(255)
    expect(reassembleTxt([[a], [b]])).toBe(record)
  })

  test("prefers a whole record over concatenating unrelated ones", () => {
    const other = "v=spf1 include:example.com -all"
    expect(reassembleTxt([[other], [keys.record]])).toBe(keys.record)
  })

  test("verifies against a key the resolver split into separate records", async () => {
    const signed = sign({
      raw: message,
      domain: "wess.io",
      selector: "corsair-1",
      privateKey: keys.privateKey,
    })
    const record = keys.record
    const split = async () => reassembleTxt([[record.slice(0, 255)], [record.slice(255)]])
    const result = await verifySignature(signed, undefined, { lookup: split })
    expect(result.result).toBe("pass")
  })

  // A truncated or corrupt key makes OpenSSL throw rather than return false.
  // The selector is chosen by whoever sent the message, so an unhandled throw
  // on the delivery path is a remote crash.
  test("a truncated key is a permerror, not a thrown exception", async () => {
    const signed = sign({
      raw: message,
      domain: "wess.io",
      selector: "corsair-1",
      privateKey: keys.privateKey,
    })
    const truncated = async () => keys.record.slice(0, 255)
    const result = await verifySignature(signed, undefined, { lookup: truncated })
    expect(result.result).toBe("permerror")
  })

  test("a key that is not base64 at all is a permerror", async () => {
    const signed = sign({
      raw: message,
      domain: "wess.io",
      selector: "corsair-1",
      privateKey: keys.privateKey,
    })
    const junk = async () => "v=DKIM1; k=rsa; p=!!!!not base64!!!!"
    const result = await verifySignature(signed, undefined, { lookup: junk })
    expect(result.result).toBe("permerror")
  })
})
