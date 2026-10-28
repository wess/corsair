import { createPublicKey, createSign, createVerify } from "node:crypto"
import {
  bodyHash,
  canonHeader,
  canonSelected,
  canonSignatureHeader,
  DEFAULT_HEADERS,
  emptySignature,
  foldSignature,
  lookupDkimKey,
  parseTags,
  pemFromRecord,
  rawFields,
  simpleBodyHash,
  simpleField,
  simpleSignatureField,
} from "../dkim/index.ts"
import { type Header, type ParsedMessage, parseMessage, stripControls } from "../mime/index.ts"

/**
 * ARC (RFC 8617): an intermediary that changes a message, or relays it from an
 * address the original sender's SPF does not cover, records what it saw and
 * seals that record, so the next hop can believe "this passed DMARC before I
 * touched it".
 *
 * Every ARC set is three headers sharing an instance number `i=`:
 *   ARC-Authentication-Results  what the sealer concluded, like Authentication-Results
 *   ARC-Message-Signature       a DKIM signature over the message, with i= for v=
 *   ARC-Seal                    a signature over every ARC header from i=1 to this one
 *
 * The canonicalisation is DKIM's, from `src/dkim`, and it is not reimplemented
 * here. That module's warning applies twice over: the header that signs itself
 * is hashed with `b=` emptied and **without its trailing CRLF**, and for the
 * seal that header is the last of a sequence of sets rather than the last of a
 * list of message headers. A signer and verifier that share a mistake agree with
 * each other and with nobody else, which is why `tests/arcwire.test.ts` rebuilds
 * the sealed input by hand and verifies it with `node:crypto`.
 */

const CRLF = "\r\n"

/** RFC 8617 §4.2.1: a chain longer than this is invalid, so nothing seals past it. */
export const MAX_INSTANCE = 50

const AAR = "arc-authentication-results"
const AMS = "arc-message-signature"
const AS = "arc-seal"

export type ArcResult = "none" | "pass" | "fail"

export type ArcChain = {
  result: ArcResult
  /** The highest instance on the message, 0 when there is no ARC header. */
  instance: number
  /** `d=` of the newest seal, set only when the chain passed. */
  sealer: string | null
  /** `cv=` as the newest sealer wrote it, which decides whether we may add to it. */
  lastCv: string | null
  reason?: string
}

type ArcSet = { aar: Header; ams: Header; as: Header }

type Lookup = (domain: string, selector: string) => Promise<string | null>

/** `i=` from an AAR, which carries it as the first element rather than as a tag list. */
const aarInstance = (value: string): string | null =>
  value.match(/^\s*i\s*=\s*([^;\s]*)\s*;/)?.[1] ?? null

const instanceOf = (header: Header): string | null =>
  header.name.toLowerCase() === AAR
    ? aarInstance(header.value)
    : (parseTags(header.value).i ?? null)

const validInstance = (raw: string | null): number | null =>
  raw && /^[1-9][0-9]?$/.test(raw) && Number(raw) <= MAX_INSTANCE ? Number(raw) : null

/**
 * The tag list of a seal or message signature, strictly (RFC 6376 §3.2): a
 * duplicated tag, a malformed tag name, or an empty element between semicolons
 * makes the header invalid rather than being read past. `parseTags` is lenient
 * because DKIM verification only needs the tags it knows; here a seal that two
 * parsers would read differently is a seal that cannot be trusted.
 */
const strictTags = (value: string): Record<string, string> | null => {
  const out: Record<string, string> = {}
  const parts = value.split(";")
  for (const [index, part] of parts.entries()) {
    if (part.trim() === "") {
      if (index === parts.length - 1) break
      return null
    }
    const eq = part.indexOf("=")
    if (eq === -1) return null
    const name = part.slice(0, eq).trim()
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) || name in out) return null
    out[name] = part
      .slice(eq + 1)
      .trim()
      .replace(/\s+/g, "")
  }
  return out
}

const isArc = (h: Header): boolean => {
  const name = h.name.toLowerCase()
  return name === AAR || name === AMS || name === AS
}

const fail = (instance: number, lastCv: string | null, reason: string): ArcChain => ({
  result: "fail",
  instance,
  sealer: null,
  lastCv,
  reason,
})

/**
 * Groups the ARC headers into sets, enforcing RFC 8617 §5.2 step 2: exactly one
 * of each header per instance, instances contiguous from 1, none above 50.
 */
const collect = (
  headers: readonly Header[],
): { sets: ArcSet[]; highest: number; error: string | null } => {
  const byInstance = new Map<number, Partial<Record<string, Header[]>>>()
  let highest = 0
  let error: string | null = null

  for (const h of headers) {
    if (!isArc(h)) continue
    const instance = validInstance(instanceOf(h))
    if (instance === null) {
      error ??= `${h.name} has no valid instance number`
      continue
    }
    highest = Math.max(highest, instance)
    const slot = byInstance.get(instance) ?? {}
    const name = h.name.toLowerCase()
    slot[name] = [...(slot[name] ?? []), h]
    byInstance.set(instance, slot)
  }

  const sets: ArcSet[] = []
  for (let i = 1; i <= highest; i++) {
    const slot = byInstance.get(i)
    const aar = slot?.[AAR]
    const ams = slot?.[AMS]
    const as = slot?.[AS]
    if (aar?.length !== 1 || ams?.length !== 1 || as?.length !== 1) {
      error ??= `instance ${i} does not hold exactly one of each ARC header`
      continue
    }
    sets.push({ aar: aar[0]!, ams: ams[0]!, as: as[0]! })
  }
  return { sets, highest, error }
}

/**
 * The input an ARC-Seal signs: every set from 1 to `upTo`, each in the order
 * AAR, AMS, AS, with the seal being computed (the last) emptied of `b=` and
 * with no CRLF after it. `sets` are already in instance order.
 */
const sealInput = (sets: readonly ArcSet[]): string => {
  let canon = ""
  sets.forEach((set, index) => {
    canon += canonHeader(set.aar.name, set.aar.value)
    canon += canonHeader(set.ams.name, set.ams.value)
    canon +=
      index === sets.length - 1
        ? canonSignatureHeader(emptySignature(set.as.value), AS)
        : canonHeader(set.as.name, set.as.value)
  })
  return canon
}

const rsaVerify = (input: string, pem: string, signature: string): boolean => {
  // Key and signature are the sender's; OpenSSL throws on malformed input, and a
  // throw here is on the delivery path.
  try {
    return createVerify("RSA-SHA256")
      .update(Buffer.from(input, "latin1"))
      .verify(pem, signature, "base64")
  } catch {
    return false
  }
}

/** RFC 8301: a key under 1024 bits verifies nothing. */
const strongEnough = (pem: string): boolean => {
  try {
    return (createPublicKey(pem).asymmetricKeyDetails?.modulusLength ?? 0) >= 1024
  } catch {
    return false
  }
}

const keyFor = async (
  lookup: Lookup,
  cache: Map<string, Promise<string | null>>,
  domain: string,
  selector: string,
): Promise<string | null> => {
  const id = `${selector}._domainkey.${domain}`.toLowerCase()
  let pending = cache.get(id)
  if (!pending) {
    pending = lookup(domain, selector).then((record) => {
      const pem = record ? pemFromRecord(record) : null
      return pem && strongEnough(pem) ? pem : null
    })
    cache.set(id, pending)
  }
  return pending
}

/**
 * Verifies one ARC-Message-Signature. It is a DKIM signature with `i=` in place
 * of `v=`, so the header selection, body hash, and self-signing rules are the
 * DKIM ones, under either canonicalisation; `c=` defaults to simple/simple.
 */
const verifyAms = async (
  ams: Header,
  tags: Record<string, string>,
  parsed: ParsedMessage,
  raw: string,
  key: (d: string, s: string) => Promise<string | null>,
): Promise<string | null> => {
  if (!tags.d || !tags.s || !tags.b || !tags.bh || tags.h === undefined) {
    return "missing a required tag"
  }
  if (tags.a !== "rsa-sha256") return "unsupported algorithm"
  // An absent c= is simple/simple (RFC 6376 §3.5). The published ARC test suite
  // signs that case as relaxed; the RFC is followed here, not the suite.
  const [headerCanon, bodyCanon = "simple"] = (tags.c ?? "simple/simple").toLowerCase().split("/")
  const known = (c: string | undefined) => c === "simple" || c === "relaxed"
  if (!known(headerCanon) || !known(bodyCanon)) return "unknown canonicalization"

  const names = tags.h
    .split(":")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean)
  if (names.includes(AS)) return "signs an ARC-Seal"

  const body = raw.slice(parsed.bodyStart)
  const bh = bodyCanon === "relaxed" ? bodyHash(body) : simpleBodyHash(body)
  if (bh !== tags.bh) return "body hash does not match"

  const pem = await key(tags.d, tags.s)
  if (!pem) return "no usable key published"

  let input: string
  if (headerCanon === "relaxed") {
    const { canon } = canonSelected(
      parsed.headers.filter((h) => h !== ams),
      names,
    )
    input = canon + canonSignatureHeader(emptySignature(ams.value), AMS)
  } else {
    // simple needs the field as it was folded on the wire, so the signature
    // header is found again among the raw fields by its unfolded value.
    const fields = rawFields(raw, parsed.bodyStart)
    const self = fields.find(
      (f) =>
        f.name.toLowerCase() === AMS &&
        f.value
          .slice(f.value.indexOf(":") + 1)
          .replace(/\r\n[ \t]+/g, " ")
          .trim() === ams.value,
    )
    if (!self) return "signature header not found"
    const { canon } = canonSelected(
      fields.filter((f) => f !== self),
      names,
      simpleField,
    )
    input = canon + simpleSignatureField(self)
  }
  return rsaVerify(input, pem, tags.b) ? null : "signature does not verify"
}

/**
 * Validates the chain on an arriving message (RFC 8617 §5.2).
 *
 * The newest AMS must verify — it covers the message as it reached us — and
 * every seal must, because each seal vouches for everything below it. Older
 * AMSs are expected to fail after an intermediary changed the message, which is
 * the situation ARC exists for, so they are not checked.
 */
export const verifyChain = async (
  raw: string,
  message?: ParsedMessage,
  opts: { lookup?: Lookup } = {},
): Promise<ArcChain> => {
  const parsed = message ?? parseMessage(raw)
  if (!parsed.headers.some(isArc)) {
    return { result: "none", instance: 0, sealer: null, lastCv: null }
  }

  const { sets, highest, error } = collect(parsed.headers)
  const newest = sets.length === highest ? sets[highest - 1] : undefined
  const lastCv = newest ? (parseTags(newest.as.value).cv?.toLowerCase() ?? null) : null
  if (error || !newest) return fail(highest, lastCv, error ?? "no ARC set")

  const seals: Record<string, string>[] = []
  for (const [index, set] of sets.entries()) {
    const tags = strictTags(set.as.value)
    if (!tags) return fail(highest, lastCv, `seal ${index + 1} has a malformed tag list`)
    const cv = tags.cv?.toLowerCase()
    const expected = index === 0 ? "none" : "pass"
    if (cv !== expected) {
      return fail(highest, lastCv, `seal ${index + 1} says cv=${cv ?? "(missing)"}`)
    }
    // A seal has no h=: what it covers is fixed by the RFC, and a seal that
    // names headers is one written to some other rule.
    if (tags.h !== undefined) return fail(highest, lastCv, `seal ${index + 1} carries h=`)
    seals.push(tags)
  }

  const cache = new Map<string, Promise<string | null>>()
  const key = (d: string, s: string) => keyFor(opts.lookup ?? lookupDkimKey, cache, d, s)

  const amsTags = strictTags(newest.ams.value)
  if (!amsTags) return fail(highest, lastCv, `message signature ${highest} is malformed`)
  const amsError = await verifyAms(newest.ams, amsTags, parsed, raw, key)
  if (amsError) return fail(highest, lastCv, `message signature ${highest}: ${amsError}`)

  for (let i = highest; i >= 1; i--) {
    const tags = seals[i - 1]!
    if (!tags.d || !tags.s || !tags.b) return fail(highest, lastCv, `seal ${i} is missing a tag`)
    if (tags.a !== "rsa-sha256") return fail(highest, lastCv, `seal ${i}: unsupported algorithm`)
    const pem = await key(tags.d, tags.s)
    if (!pem) return fail(highest, lastCv, `seal ${i}: no usable key published`)
    if (!rsaVerify(sealInput(sets.slice(0, i)), pem, tags.b)) {
      return fail(highest, lastCv, `seal ${i} does not verify`)
    }
  }

  return {
    result: "pass",
    instance: highest,
    sealer: seals[highest - 1]!.d!.toLowerCase(),
    lastCv,
  }
}

// local policy

/**
 * The sealer whose word overrides a DMARC failure, or null.
 *
 * RFC 7489 §6.7 lets a receiver override DMARC by local policy, and forwarded
 * mail is the case it names: a list that rewrites the subject or a forwarder
 * without SRS breaks both alignments, and DMARC fails on mail that was genuine.
 * A passing ARC chain says the newest sealer saw it pass — but anyone can seal,
 * so the override needs the operator to have named that sealer. `d=` must equal
 * a listed domain or be a subdomain of one: the key resolved under that name,
 * and only its owner can publish there.
 */
export const dmarcOverride = (
  dmarc: string,
  chain: Pick<ArcChain, "result" | "sealer">,
  trusted: readonly string[],
): string | null => {
  if (dmarc !== "fail" || chain.result !== "pass" || !chain.sealer) return null
  const sealer = chain.sealer.toLowerCase()
  const match = trusted.some((entry) => {
    const t = entry.trim().toLowerCase().replace(/\.$/, "")
    return t !== "" && (sealer === t || sealer.endsWith(`.${t}`))
  })
  return match ? sealer : null
}

// seal

export type SealInput = {
  /** The message exactly as it will be relayed. */
  raw: string
  /** What `verifyChain` found on the message as it arrived. */
  chain: Pick<ArcChain, "result" | "instance" | "lastCv">
  /** Our Authentication-Results authserv-id — the hostname. */
  authservId: string
  /** The Authentication-Results payload after the authserv-id. */
  results: string
  domain: string
  selector: string
  privateKey: string
  headers?: string[]
  timestamp?: number
}

const sign = (input: string, privateKey: string): string =>
  createSign("RSA-SHA256").update(Buffer.from(input, "latin1")).sign(privateKey, "base64")

/**
 * Adds one ARC set (RFC 8617 §5.1) and returns the message with it on top.
 * Returns the message untouched where the RFC says not to seal: the newest seal
 * already says cv=fail, so the chain is over, or the next instance would pass 50.
 *
 * A chain we found broken is still sealed, with cv=fail, and that seal covers
 * only the set we add (§5.1.2) — the sets below it are what failed.
 */
export const seal = (input: SealInput): string => {
  const { chain } = input
  if (chain.lastCv === "fail") return input.raw
  const instance = chain.instance + 1
  if (instance > MAX_INSTANCE) return input.raw
  const cv: ArcResult = chain.result

  const parsed = parseMessage(input.raw)
  const body = input.raw.slice(parsed.bodyStart)
  const t = input.timestamp ?? Math.floor(Date.now() / 1000)
  const domain = stripControls(input.domain)
  const selector = stripControls(input.selector)

  const aar: Header = {
    name: "ARC-Authentication-Results",
    value: `i=${instance}; ${stripControls(input.authservId)}; ${stripControls(input.results)}`,
  }

  // The message signature does not cover any ARC header — a seal covers those —
  // and adds DKIM-Signature to the usual set, so the original signature is
  // vouched for as it arrived here.
  const wanted = (input.headers ?? [...DEFAULT_HEADERS, "dkim-signature"]).filter(
    (n) => n.toLowerCase() !== AAR && n.toLowerCase() !== AMS && n.toLowerCase() !== AS,
  )
  const selected = canonSelected(parsed.headers, wanted)
  const amsTags = [
    `i=${instance}`,
    "a=rsa-sha256",
    "c=relaxed/relaxed",
    `d=${domain}`,
    `s=${selector}`,
    `t=${t}`,
    `bh=${bodyHash(body)}`,
    `h=${selected.names.join(":")}`,
    "b=",
  ].join("; ")
  const amsSig = sign(selected.canon + canonSignatureHeader(amsTags, AMS), input.privateKey)
  const ams: Header = { name: "ARC-Message-Signature", value: `${amsTags}${amsSig}` }

  const asTags = [
    `i=${instance}`,
    "a=rsa-sha256",
    `cv=${cv}`,
    `d=${domain}`,
    `s=${selector}`,
    `t=${t}`,
    "b=",
  ].join("; ")
  const prior = cv === "pass" ? collect(parsed.headers).sets : []
  const pending: ArcSet = { aar, ams, as: { name: "ARC-Seal", value: asTags } }
  const asSig = sign(sealInput([...prior, pending]), input.privateKey)

  return [
    foldSignature(`ARC-Seal: ${asTags}${asSig}`),
    foldSignature(`ARC-Message-Signature: ${ams.value}`),
    foldSignature(`ARC-Authentication-Results: ${aar.value}`),
    input.raw,
  ].join(CRLF)
}
