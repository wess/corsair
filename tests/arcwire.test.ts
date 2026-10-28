import { describe, expect, test } from "bun:test"
import { createHash, createVerify } from "node:crypto"
import { seal } from "../src/arc/index.ts"
import { generateKeyPair } from "../src/dkim/index.ts"

/**
 * ARC sets this server produces, checked against RFC 8617 rather than against
 * this server — the same reasoning as `tests/dkimwire.test.ts`. A sealer and a
 * verifier that share a canonicalisation mistake pass every round trip and fail
 * at every other receiver, silently. So everything below rebuilds the signed
 * input by hand, from the spec, and verifies with `node:crypto` directly.
 */

const RAW = [
  "Received: from far.invalid ([203.0.113.9]) by mx.example.invalid",
  "Authentication-Results: mx.example.invalid; spf=pass smtp.mailfrom=alice@far.invalid",
  "From: Alice <alice@far.invalid>",
  "To: list@example.invalid",
  "Subject: a message with   collapsing   whitespace",
  "Date: Wed, 12 Aug 2026 12:00:00 +0000",
  "Message-ID: <arc-wire@far.invalid>",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "the body,   with runs   of spaces   ",
  "",
  "",
].join("\r\n")

const relaxed = (name: string, value: string) =>
  `${name.toLowerCase()}:${value
    .replace(/\r\n[ \t]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()}\r\n`

const unfold = (value: string) =>
  value
    .replace(/\r\n[ \t]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()

/** Every occurrence of a header, top to bottom, continuation lines included. */
const headerValues = (message: string, name: string): string[] => {
  const head = message.slice(0, message.indexOf("\r\n\r\n"))
  const lines = head.split("\r\n")
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.toLowerCase().startsWith(`${name.toLowerCase()}:`)) continue
    let value = lines[i]!.slice(lines[i]!.indexOf(":") + 1)
    while (/^[ \t]/.test(lines[i + 1] ?? "")) value += `\r\n${lines[++i]}`
    out.push(value)
  }
  return out
}

const tag = (value: string, name: string): string =>
  unfold(value)
    .split(";")
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .replace(/\s+/g, "") ?? ""

const instanceOf = (value: string) => tag(value, "i")

const emptyB = (value: string) => unfold(value).replace(/(^|;)(\s*b=)[^;]*/, "$1$2")

const verify = (input: string, publicKey: string, b: string) =>
  createVerify("RSA-SHA256").update(Buffer.from(input, "latin1")).verify(publicKey, b, "base64")

/** RFC 6376 §3.4.4, written out longhand. */
const relaxedBodyHash = (message: string) => {
  const body = message.slice(message.indexOf("\r\n\r\n") + 4)
  const lines = body.split("\r\n").map((l) => l.replace(/[ \t]+/g, " ").replace(/ $/, ""))
  while (lines.length && lines[lines.length - 1] === "") lines.pop()
  const canon = lines.length ? `${lines.join("\r\n")}\r\n` : ""
  return createHash("sha256").update(Buffer.from(canon, "latin1")).digest("base64")
}

/** The ARC set with instance `i`, as raw header values. */
const setOf = (message: string, i: number) => {
  const pick = (name: string, inst: (v: string) => string) =>
    headerValues(message, name).find((v) => inst(v) === String(i)) ?? ""
  return {
    aar: pick("ARC-Authentication-Results", (v) => v.match(/^\s*i=(\d+)/)?.[1] ?? ""),
    ams: pick("ARC-Message-Signature", instanceOf),
    as: pick("ARC-Seal", instanceOf),
  }
}

/** What ARC-Seal i=n signs: sets 1..n in order AAR, AMS, AS; the last AS without b= and CRLF. */
const sealedInput = (message: string, from: number, to: number) => {
  let input = ""
  for (let i = from; i <= to; i++) {
    const set = setOf(message, i)
    input += relaxed("arc-authentication-results", set.aar)
    input += relaxed("arc-message-signature", set.ams)
    input +=
      i === to ? relaxed("arc-seal", emptyB(set.as)).slice(0, -2) : relaxed("arc-seal", set.as)
  }
  return input
}

const hopA = generateKeyPair()
const hopB = generateKeyPair()

const first = seal({
  raw: RAW,
  chain: { result: "none", instance: 0, lastCv: null },
  authservId: "mx.example.invalid",
  results: "spf=pass smtp.mailfrom=alice@far.invalid; dkim=none; dmarc=pass; arc=none",
  domain: "example.invalid",
  selector: "corsair-1",
  privateKey: hopA.privateKey,
  timestamp: 1_800_000_000,
})

describe("the wire format of a first ARC set", () => {
  test("the three headers are on top, numbered i=1, the seal saying cv=none", () => {
    const lines = first.split("\r\n")
    expect(lines[0]).toStartWith("ARC-Seal: i=1;")
    const set = setOf(first, 1)
    expect(set.aar).toContain("mx.example.invalid; spf=pass")
    expect(tag(set.as, "cv")).toBe("none")
    expect(tag(set.as, "h")).toBe("")
    expect(first.endsWith(RAW)).toBe(true)
  })

  test("the message signature verifies against an input rebuilt from the RFC", () => {
    const ams = setOf(first, 1).ams
    expect(tag(ams, "bh")).toBe(relaxedBodyHash(RAW))
    expect(tag(ams, "c")).toBe("relaxed/relaxed")

    let input = ""
    for (const name of tag(ams, "h").split(":")) {
      const values = headerValues(RAW, name)
      input += relaxed(name, values[values.length - 1] ?? "")
    }
    input += relaxed("arc-message-signature", emptyB(ams)).slice(0, -2)
    expect(verify(input, hopA.publicKey, tag(ams, "b"))).toBe(true)
  })

  test("the message signature covers no ARC header", () => {
    const names = tag(setOf(first, 1).ams, "h").toLowerCase().split(":")
    expect(names.some((n) => n.startsWith("arc-"))).toBe(false)
    expect(names).toContain("from")
  })

  test("the seal verifies over AAR, AMS, and itself with b= emptied and no CRLF", () => {
    const b = tag(setOf(first, 1).as, "b")
    expect(verify(sealedInput(first, 1, 1), hopA.publicKey, b)).toBe(true)
  })

  test("the same input with a trailing CRLF on the seal does not verify", () => {
    // The DKIM bug, in its ARC shape: what a receiver would compute if we
    // included the CRLF and it did not.
    const b = tag(setOf(first, 1).as, "b")
    expect(verify(`${sealedInput(first, 1, 1)}\r\n`, hopA.publicKey, b)).toBe(false)
  })
})

describe("a second hop", () => {
  // The second hop appends a footer, as a list does. Its own AMS covers the
  // changed body; the first AMS no longer verifies, and that is fine.
  const changed = `${first}-- \r\nlist footer\r\n`
  const second = seal({
    raw: changed,
    chain: { result: "pass", instance: 1, lastCv: "none" },
    authservId: "relay.example.invalid",
    results: "arc=pass",
    domain: "relay.invalid",
    selector: "corsair-2",
    privateKey: hopB.privateKey,
    timestamp: 1_800_000_100,
  })

  test("seals with i=2 and cv=pass, over both sets in order", () => {
    const set = setOf(second, 2)
    expect(tag(set.as, "cv")).toBe("pass")
    expect(tag(set.as, "d")).toBe("relay.invalid")
    expect(verify(sealedInput(second, 1, 2), hopB.publicKey, tag(set.as, "b"))).toBe(true)
  })

  test("leaves the first seal verifiable", () => {
    expect(verify(sealedInput(second, 1, 1), hopA.publicKey, tag(setOf(second, 1).as, "b"))).toBe(
      true,
    )
  })

  test("a seal over only its own set would not verify for a passing chain", () => {
    expect(verify(sealedInput(second, 2, 2), hopB.publicKey, tag(setOf(second, 2).as, "b"))).toBe(
      false,
    )
  })
})

describe("sealing a chain that failed", () => {
  test("seals with cv=fail over its own set alone (RFC 8617 §5.1.2)", () => {
    const sealed = seal({
      raw: first,
      chain: { result: "fail", instance: 1, lastCv: "none" },
      authservId: "relay.example.invalid",
      results: "arc=fail",
      domain: "relay.invalid",
      selector: "corsair-2",
      privateKey: hopB.privateKey,
    })
    const set = setOf(sealed, 2)
    expect(tag(set.as, "cv")).toBe("fail")
    expect(verify(sealedInput(sealed, 2, 2), hopB.publicKey, tag(set.as, "b"))).toBe(true)
  })
})
