import { createVerify } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { dkimRecord, generateKeyPair, sign, verifySignature } from "../src/dkim/index.ts"

/**
 * The signature this server produces, checked against the RFC rather than
 * against this server.
 *
 * The bug this exists to catch could not be caught any other way. `sign()` and
 * `verifySignature()` both fed the DKIM-Signature header to the hash *with* its
 * trailing CRLF, which RFC 6376 §3.7 excludes. Sharing the mistake, they agreed
 * with each other perfectly: a round-trip test passed, the signature was
 * well-formed, the key resolved — and every other implementation rejected every
 * message this server ever signed, while every correctly-signed message
 * arriving here failed verification. The only visible symptom was `dkim=fail`
 * in other people's headers.
 *
 * So the assertion below rebuilds the signed data by hand, from the spec, and
 * verifies with `node:crypto` directly. If the production canonicalisation
 * drifts from the RFC again, this fails even if the code still agrees with
 * itself.
 */

const RAW = [
  "From: Alice <alice@example.invalid>",
  "To: Bob <bob@example.invalid>",
  "Subject: a message with   collapsing   whitespace",
  "Date: Wed, 12 Aug 2026 12:00:00 +0000",
  "Message-ID: <wire-test@example.invalid>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "the body, which is hashed separately",
  "",
].join("\r\n")

const relaxed = (name: string, value: string) =>
  `${name.toLowerCase()}:${value
    .replace(/\r\n[ \t]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()}\r\n`

/** Pulls one header's full value, continuation lines included. */
const headerValue = (message: string, name: string): string => {
  const lines = message.split("\r\n")
  const start = lines.findIndex((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`))
  if (start === -1) return ""
  let value = lines[start]!.slice(lines[start]!.indexOf(":") + 1)
  for (let i = start + 1; i < lines.length; i++) {
    if (!/^[ \t]/.test(lines[i] ?? "")) break
    value += `\r\n${lines[i]}`
  }
  return value
}

describe("the wire format of a signature this server produces", () => {
  const pair = generateKeyPair()
  const signed = sign({
    raw: RAW,
    domain: "example.invalid",
    selector: "corsair-1",
    privateKey: pair.privateKey,
  })

  test("verifies against a signed input rebuilt from the RFC", () => {
    const sigValue = headerValue(signed, "DKIM-Signature")
    const unfolded = sigValue
      .replace(/\r\n[ \t]+/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim()
    const b = unfolded.match(/\bb=([^;]*)/)?.[1]?.replace(/\s+/g, "") ?? ""
    const h = unfolded.match(/\bh=([^;]*)/)?.[1]?.trim() ?? ""
    expect(b).not.toBe("")
    expect(h).not.toBe("")

    let input = ""
    for (const name of h.split(":")) {
      input += relaxed(name, headerValue(RAW, name))
    }
    // The signature header itself, b= emptied — and with **no** trailing CRLF.
    // That single missing pair of bytes is the entire bug.
    input += relaxed("dkim-signature", unfolded.replace(/\bb=[^;]*/, "b=")).slice(0, -2)

    const ok = createVerify("RSA-SHA256")
      .update(Buffer.from(input, "latin1"))
      .verify(pair.publicKey, b, "base64")

    expect(ok).toBe(true)
  })

  test("a trailing CRLF on the signature header would not verify", () => {
    // The shape of the old bug, asserted directly: the same input plus the CRLF
    // must fail, which is what every receiver was computing.
    const sigValue = headerValue(signed, "DKIM-Signature")
    const unfolded = sigValue
      .replace(/\r\n[ \t]+/g, " ")
      .replace(/[ \t]+/g, " ")
      .trim()
    const b = unfolded.match(/\bb=([^;]*)/)?.[1]?.replace(/\s+/g, "") ?? ""
    const h = unfolded.match(/\bh=([^;]*)/)?.[1]?.trim() ?? ""

    let input = ""
    for (const name of h.split(":")) input += relaxed(name, headerValue(RAW, name))
    input += relaxed("dkim-signature", unfolded.replace(/\bb=[^;]*/, "b="))

    const ok = createVerify("RSA-SHA256")
      .update(Buffer.from(input, "latin1"))
      .verify(pair.publicKey, b, "base64")

    expect(ok).toBe(false)
  })

  test("this server's own verifier agrees with the independent check", async () => {
    // Kept, but it is the weaker assertion: it passed throughout the outage.
    const result = await verifySignature(signed, undefined, {
      lookup: async () => dkimRecord(pair.publicKey),
    })
    expect(result.result).toBe("pass")
  })
})
