/**
 * Exercises DNS-dependent code against real resolvers.
 *
 *   bun run test:dns [domain]
 *
 * This is the blind spot that let a remote crash ship. Every unit test injects a
 * `lookup` stub that hands back a DKIM key as one clean string, so the code that
 * reassembles a real resolver's answer was never executed — and Bun's
 * `resolveTxt` splits a long TXT record differently from Node's, which produced
 * a truncated key, a PEM that would not decode, and a `crypto.verify` that threw
 * out of the inbound delivery path and killed the process.
 *
 * A stub cannot catch that class of bug by construction. This needs the network,
 * so it is a separate script rather than part of `bun test`: a suite that fails
 * on a train is a suite people stop trusting. No network is a skip.
 */

import { resolveTxt } from "node:dns/promises"
import { lookupDkimKey, reassembleTxt, verifySignature } from "../src/dkim/index.ts"
import { checkSpf } from "../src/spf/index.ts"

const results: { label: string; ok: boolean; detail: string }[] = []
let skipped = false

const check = async (label: string, fn: () => Promise<string>) => {
  try {
    results.push({ label, ok: true, detail: await fn() })
  } catch (e) {
    const message = (e as Error).message
    if (/ENOTFOUND|EAI_AGAIN|ETIMEOUT|queryTxt|ECONNREFUSED/i.test(message)) {
      skipped = true
      results.push({ label, ok: true, detail: `skipped — no resolver (${message})` })
      return
    }
    results.push({ label, ok: false, detail: message })
  }
}

// ------------------------------------------------------------ chunked keys --

/**
 * Every 2048-bit DKIM key is longer than the 255-byte cap on a single TXT
 * string, so a real published key is always split. These are third-party
 * selectors chosen because they are long-lived and their keys are chunked.
 */
const CHUNKED = [
  // Ours, and 2048-bit by construction — the guaranteed chunked case.
  { domain: process.argv[2] ?? "wess.dev", selector: "corsair-1" },
  // Third-party 2048-bit selectors, in case the domain above is not hosted here.
  { domain: "protonmail.com", selector: "protonmail" },
  { domain: "fastmail.com", selector: "fm1" },
]

/** Only a 2048-bit key exceeds the 255-byte cap and is therefore split. */
const isChunked = (records: (string | string[])[]): boolean =>
  records.length > 1 || records.flat().join("").length > 255

await check("a real resolver splits a long TXT record", async () => {
  for (const { domain, selector } of CHUNKED) {
    const raw = await resolveTxt(`${selector}._domainkey.${domain}`).catch(() => null)
    if (!raw?.length) continue
    if (!isChunked(raw)) continue
    const shape = raw.map((r) => (Array.isArray(r) ? r.length : 1))
    const total = raw.flat().join("").length
    return `${selector}._domainkey.${domain}: ${raw.length} record(s), chunk shape ${JSON.stringify(shape)}, ${total} bytes`
  }
  throw new Error(
    "no chunked (2048-bit) key found among the probe domains — the reassembly " +
      "path is therefore untested; add a domain that publishes one",
  )
})

await check("a chunked key reassembles into a usable PEM", async () => {
  const { createPublicKey } = await import("node:crypto")

  for (const { domain, selector } of CHUNKED) {
    const raw = await resolveTxt(`${selector}._domainkey.${domain}`).catch(() => null)
    if (!raw?.length || !isChunked(raw)) continue

    const record = await lookupDkimKey(domain, selector)
    if (!record) throw new Error(`${selector}._domainkey.${domain}: lookup returned nothing`)

    const p = record.split("p=")[1]?.replace(/[;\s]/g, "") ?? ""
    const lines = p.match(/.{1,64}/g) ?? []

    // The assertion is that it parses as a key, not that it is a certain
    // length: a truncated key is still valid base64 of a plausible size, which
    // is exactly why a cheaper check let the original bug through.
    const key = createPublicKey(
      `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`,
    )
    const bits = (key.asymmetricKeyDetails?.modulusLength ?? 0) as number
    if (bits < 2048) throw new Error(`reassembled to a ${bits}-bit key — truncated`)

    return `${selector}._domainkey.${domain}: ${p.length} chars → ${bits}-bit key`
  }
  throw new Error("no chunked key available to reassemble")
})

await check("both resolver shapes reassemble identically", async () => {
  const record = "v=DKIM1; k=rsa; p=" + "A".repeat(400)
  const a = record.slice(0, 255)
  const b = record.slice(255)
  const node = reassembleTxt([[a, b]])
  const bun = reassembleTxt([[a], [b]])
  if (node !== bun) throw new Error("Node and Bun shapes disagree")
  if (node !== record) throw new Error("reassembly lost bytes")
  return "one record with two chunks === two records with one chunk each"
})

// -------------------------------------------------------------- malformed --

await check("a selector that does not exist is not a crash", async () => {
  // Some zones answer a wildcard, and an empty `p=` is a legitimate "revoked"
  // record. Either is fine; the requirement is that it does not throw and does
  // not yield something a verifier would treat as a valid key.
  const record = await lookupDkimKey("example.com", "definitely-not-a-real-selector")
  if (record === null) return "returns null"
  const p = record.split("p=")[1]?.replace(/[;\s]/g, "") ?? ""
  if (p.length > 0) throw new Error(`unexpected key material: ${record.slice(0, 50)}`)
  return `returns a revoked record (empty p=), which verifies as permerror`
})

// -------------------------------------------------------------------- spf --

await check("SPF resolves and evaluates against a real record", async () => {
  const result = await checkSpf({
    ip: "209.85.220.41", // a Google sending address
    mailFrom: "someone@gmail.com",
    helo: "mail-sor-f41.google.com",
  })
  if (!result?.result) throw new Error("no result")
  return `gmail.com from a Google IP → ${result.result}`
})

await check("SPF for a domain with no record is `none`, not an error", async () => {
  const result = await checkSpf({
    ip: "203.0.113.9",
    mailFrom: "someone@example.invalid",
    helo: "example.invalid",
  })
  return `example.invalid → ${result?.result ?? "null"}`
})

// ------------------------------------------------------- end-to-end verify --

await check("a real signed message verifies through real DNS", async () => {
  // Signed by GitHub with a chunked key: the exact combination that crashed.
  const domain = "github.com"
  const selector = "pf2023"
  const record = await lookupDkimKey(domain, selector)
  if (!record) throw new Error("could not fetch the key")

  // A signature that will not verify, but must fail *cleanly* rather than throw.
  const message = [
    `DKIM-Signature: v=1; a=rsa-sha256; d=${domain}; s=${selector}; h=from:subject;`,
    " bh=aGVsbG8=; b=bm90YXJlYWxzaWduYXR1cmU=",
    "From: someone@github.com",
    "Subject: not really signed",
    "",
    "body",
    "",
  ].join("\r\n")

  const verdict = await verifySignature(message)
  if (verdict.result === "pass") throw new Error("a forged signature must not pass")
  return `forged signature → ${verdict.result} (no exception)`
})

// ----------------------------------------------------------------- report --

console.log()
for (const { label, ok, detail } of results) {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}`)
  console.log(`        ${detail}`)
}

const failed = results.filter((r) => !r.ok)
console.log()
if (failed.length) {
  console.log(`DNS: FAIL — ${failed.length} of ${results.length}`)
  process.exit(1)
}
console.log(skipped ? "DNS: pass (some checks skipped, no resolver)" : "DNS: pass")
