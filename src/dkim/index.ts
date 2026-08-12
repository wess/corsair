import { createHash, createSign, createVerify, generateKeyPairSync } from "node:crypto"
import { resolveTxt } from "node:dns/promises"
import {
  type Header,
  headerValue,
  type ParsedMessage,
  parseMessage,
  splitHeaders,
} from "../mime/index.ts"

const CRLF = "\r\n"

export type KeyPair = { privateKey: string; publicKey: string; record: string }

/**
 * 2048 bits is the floor the large receivers accept, and 1024 is actively
 * penalised. It does not fit in a single 255-character TXT string, which is why
 * the DNS record has to be published as a quoted, chunked value — see
 * `dkimRecord`.
 */
export const generateKeyPair = (): KeyPair => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  })
  return { privateKey, publicKey, record: dkimRecord(publicKey) }
}

/** The `v=DKIM1; k=rsa; p=<base64>` value that goes in the TXT record. */
export const dkimRecord = (publicKeyPem: string): string => {
  const body = publicKeyPem.replace(/-----(BEGIN|END) PUBLIC KEY-----/g, "").replace(/\s+/g, "")
  return `v=DKIM1; k=rsa; p=${body}`
}

// ------------------------------------------------------- canonicalisation --

/**
 * relaxed header canonicalisation (RFC 6376 §3.4.2): lower-case the name,
 * unfold, collapse runs of whitespace, trim the ends.
 */
const canonHeader = (name: string, value: string): string =>
  `${name.toLowerCase()}:${value
    .replace(/\r\n[ \t]+/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim()}${CRLF}`

/**
 * The DKIM-Signature header as it is fed to the hash: canonicalised like any
 * other, with its `b=` value emptied, and **without the trailing CRLF**
 * (RFC 6376 §3.7). It is the last thing hashed and nothing follows it, so the
 * CRLF that separates headers is not part of the input.
 *
 * Getting this wrong is invisible from inside. The signer and the verifier here
 * shared the mistake, so this server verified its own signatures perfectly and
 * every other implementation on earth rejected them — outbound mail carried
 * `dkim=fail` to every receiver, and inbound mail from correctly-signing
 * senders failed here for the same reason. Nothing logged an error; the
 * signature was well-formed, the key resolved, and the arithmetic just did not
 * agree.
 */
const canonSignatureHeader = (value: string): string =>
  canonHeader("dkim-signature", value).slice(0, -CRLF.length)

/**
 * relaxed body canonicalisation (RFC 6376 §3.4.4): strip trailing whitespace on
 * each line, collapse internal whitespace runs, drop trailing empty lines, and
 * end with exactly one CRLF — unless the body is empty, which canonicalises to
 * the empty string.
 */
export const canonBody = (body: string): string => {
  const collapsed = body
    .split(CRLF)
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, ""))
    .join(CRLF)
  const trimmed = collapsed.replace(/(?:\r\n)+$/, "")
  return trimmed === "" ? "" : trimmed + CRLF
}

const bodyHash = (body: string): string =>
  createHash("sha256")
    .update(Buffer.from(canonBody(body), "latin1"))
    .digest("base64")

// -------------------------------------------------------------------- sign --

export type SignInput = {
  raw: string
  domain: string
  selector: string
  privateKey: string
  /** Defaults to the set every verifier expects to see covered. */
  headers?: string[]
}

const DEFAULT_HEADERS = [
  "from",
  "to",
  "cc",
  "subject",
  "date",
  "message-id",
  "mime-version",
  "content-type",
  "content-transfer-encoding",
  "reply-to",
  "in-reply-to",
  "references",
]

/**
 * Returns the message with a DKIM-Signature header prepended.
 *
 * The signature covers only headers that are actually present. Signing a header
 * that is absent is legal and adds replay protection, but it also means adding
 * that header later invalidates the signature, and intermediate relays do add
 * headers.
 */
export const sign = (input: SignInput): string => {
  const { headers, bodyStart } = splitHeaders(input.raw)
  const body = input.raw.slice(bodyStart)

  const wanted = (input.headers ?? DEFAULT_HEADERS).map((h) => h.toLowerCase())
  // Signed in the order given, and only for headers that exist. Duplicates are
  // taken from the bottom up, per RFC 6376 §5.4.2.
  const remaining = new Map<string, Header[]>()
  for (const h of headers) {
    const key = h.name.toLowerCase()
    const list = remaining.get(key) ?? []
    list.push(h)
    remaining.set(key, list)
  }

  const signedNames: string[] = []
  let canon = ""
  for (const name of wanted) {
    const list = remaining.get(name)
    if (!list?.length) continue
    const header = list.pop()!
    signedNames.push(header.name)
    canon += canonHeader(header.name, header.value)
  }

  const bh = bodyHash(body)
  const tags = [
    "v=1",
    "a=rsa-sha256",
    "c=relaxed/relaxed",
    `d=${input.domain}`,
    `s=${input.selector}`,
    `t=${Math.floor(Date.now() / 1000)}`,
    `bh=${bh}`,
    `h=${signedNames.join(":")}`,
    "b=",
  ].join("; ")

  // The DKIM-Signature header signs itself with an empty b= value.
  const toSign = canon + canonSignatureHeader(tags)
  const signature = createSign("RSA-SHA256")
    .update(Buffer.from(toSign, "latin1"))
    .sign(input.privateKey, "base64")

  const header = foldSignature(`DKIM-Signature: ${tags}${signature}`)
  return `${header}${CRLF}${input.raw}`
}

// A header longer than 78 characters has to be folded, and the signature is
// always longer than that.
const foldSignature = (line: string): string => {
  const out: string[] = []
  let current = ""
  for (const token of line.split(" ")) {
    if (current && current.length + token.length + 1 > 76) {
      out.push(current)
      current = `\t${token}`
    } else current = current ? `${current} ${token}` : token
  }
  if (current) out.push(current)
  return out.join(CRLF)
}

// ------------------------------------------------------------------ verify --

export type DkimResult = {
  result: "pass" | "fail" | "none" | "temperror" | "permerror"
  domain: string | null
  selector: string | null
  reason?: string
}

const parseTags = (value: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const part of value.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    out[part.slice(0, eq).trim()] = part
      .slice(eq + 1)
      .trim()
      .replace(/\s+/g, "")
  }
  return out
}

const pemFromRecord = (record: string): string | null => {
  const tags = parseTags(record)
  if (!tags.p) return null

  // The key comes from DNS controlled by whoever sent the message, so it is
  // attacker-supplied. Reject anything that is not base64 here rather than
  // letting OpenSSL throw on it later.
  const key = tags.p.replace(/\s+/g, "")
  if (!key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key) || key.length % 4 !== 0) return null

  const lines = key.match(/.{1,64}/g) ?? []
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`
}

export const lookupDkimKey = async (domain: string, selector: string): Promise<string | null> => {
  try {
    const records = await resolveTxt(`${selector}._domainkey.${domain}`)
    return reassembleTxt(records)
  } catch {
    return null
  }
}

/**
 * Rebuilds one DKIM record from whatever shape the resolver returned.
 *
 * A DNS TXT string cannot exceed 255 bytes, so every 2048-bit DKIM key is
 * published as several strings that the reader concatenates. **Node and Bun
 * disagree about how to present them.** Node returns one record with several
 * chunks — `[[a, b]]` — while Bun 1.3 returns each string as its own record —
 * `[[a], [b]]`.
 *
 * Taking the first record that merely *contains* `p=` therefore yields a
 * truncated key under Bun, and a truncated key is not a soft failure: the PEM
 * fails to base64-decode and `crypto.verify` **throws**. Since the selector is
 * chosen by whoever sent the message, that turned any DKIM-signed mail from a
 * domain with a normal-length key — which is to say most mail — into a crash.
 *
 * So: try each record on its own first, because a name may legitimately hold
 * more than one TXT record and only one of them is the DKIM key. Only if none
 * of them parses do we treat the set as one record split across entries and
 * concatenate it, which is the Bun case.
 */
export const reassembleTxt = (records: (string | string[])[]): string | null => {
  const flat = records.map((r) => (Array.isArray(r) ? r.join("") : r))

  const whole = flat.find((r) => r.includes("p=") && pemFromRecord(r) !== null)
  if (whole) return whole

  const concatenated = flat.join("")
  if (concatenated.includes("p=") && pemFromRecord(concatenated) !== null) return concatenated

  // Nothing usable. Returning the best candidate rather than null keeps the
  // caller's "published key is unreadable" permerror, which is more accurate
  // than "no key published".
  return flat.find((r) => r.includes("p=")) ?? null
}

/**
 * Verifies the first DKIM-Signature on a message. Only the first is checked
 * because that is the one this server's policy decisions are based on; a
 * message with several valid signatures still only needs one to align.
 */
export const verifySignature = async (
  raw: string,
  message?: ParsedMessage,
  // Overridable so the signing round trip can be tested without publishing DNS.
  opts: { lookup?: (domain: string, selector: string) => Promise<string | null> } = {},
): Promise<DkimResult> => {
  const parsed = message ?? parseMessage(raw)
  const lookup = opts.lookup ?? lookupDkimKey
  const sigHeader = parsed.headers.find((h) => h.name.toLowerCase() === "dkim-signature")
  if (!sigHeader) return { result: "none", domain: null, selector: null }

  const tags = parseTags(sigHeader.value)
  const domain = tags.d ?? null
  const selector = tags.s ?? null
  if (!domain || !selector || !tags.b || !tags.bh || !tags.h) {
    return { result: "permerror", domain, selector, reason: "signature is missing required tags" }
  }

  const record = await lookup(domain, selector)
  if (!record) {
    return { result: "temperror", domain, selector, reason: "no key published for that selector" }
  }
  const pem = pemFromRecord(record)
  if (!pem) {
    return { result: "permerror", domain, selector, reason: "published key is unreadable" }
  }

  const body = raw.slice(parsed.bodyStart)
  const truncated = tags.l ? body.slice(0, Number(tags.l)) : body
  if (bodyHash(truncated) !== tags.bh) {
    return { result: "fail", domain, selector, reason: "body hash does not match" }
  }

  // Rebuild exactly what the signer hashed: the listed headers, bottom-up for
  // duplicates, then the signature header itself with b= emptied.
  const pool = new Map<string, Header[]>()
  for (const h of parsed.headers) {
    if (h === sigHeader) continue
    const key = h.name.toLowerCase()
    const list = pool.get(key) ?? []
    list.push(h)
    pool.set(key, list)
  }

  let canon = ""
  for (const name of tags.h.split(":").map((n) => n.trim().toLowerCase())) {
    const list = pool.get(name)
    if (!list?.length) continue
    const header = list.pop()!
    canon += canonHeader(header.name, header.value)
  }
  const stripped = sigHeader.value.replace(/\bb=[^;]*/, "b=")
  canon += canonSignatureHeader(stripped)

  // Both the key and the signature come from the message and from DNS the sender
  // controls, and OpenSSL throws rather than returning false on malformed input.
  // An unhandled throw here kills the process from the delivery path, so a
  // sender could take the server down with one message.
  let ok = false
  try {
    ok = createVerify("RSA-SHA256")
      .update(Buffer.from(canon, "latin1"))
      .verify(pem, tags.b.replace(/\s+/g, ""), "base64")
  } catch (e) {
    return {
      result: "permerror",
      domain,
      selector,
      reason: `key or signature is malformed: ${(e as Error).message}`,
    }
  }

  return ok
    ? { result: "pass", domain, selector }
    : { result: "fail", domain, selector, reason: "signature does not verify" }
}

/**
 * DMARC alignment for DKIM: the signing domain must match the From domain,
 * either exactly (strict) or as an organisational-domain suffix (relaxed).
 */
export const aligned = (
  fromDomain: string,
  signingDomain: string,
  mode: "strict" | "relaxed" = "relaxed",
): boolean => {
  const a = fromDomain.toLowerCase()
  const b = signingDomain.toLowerCase()
  if (a === b) return true
  if (mode === "strict") return false
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}

export const fromDomainOf = (message: ParsedMessage): string | null => {
  const from = headerValue(message.headers, "from")
  const at = from?.lastIndexOf("@") ?? -1
  if (!from || at === -1) return null
  return from
    .slice(at + 1)
    .replace(/[>\s].*$/, "")
    .toLowerCase()
}
