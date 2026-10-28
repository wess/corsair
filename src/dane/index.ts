import { createHash, createPublicKey, type KeyObject, X509Certificate } from "node:crypto"
import { isIP } from "node:net"
import { config } from "../config/index.ts"
import {
  type Answer,
  canonicalName,
  type Message,
  query,
  RCODE,
  type Server,
  type Tlsa,
  TYPE,
} from "../dnswire/index.ts"

/**
 * DANE for outbound SMTP (RFC 7672).
 *
 * Opportunistic STARTTLS stops a passive eavesdropper and nothing else: anyone on
 * the path can strip the STARTTLS capability or present any certificate, and the
 * sender carries on. A receiving domain that publishes TLSA records under a
 * DNSSEC-signed zone is asking for more — STARTTLS becomes mandatory and the
 * certificate must match a record. The DNSSEC part is the whole point: an
 * unsigned TLSA record is exactly as forgeable as the STARTTLS line it is meant
 * to protect, so the AD bit decides everything here.
 *
 * ## Whose AD bit
 *
 * This server does not validate DNSSEC itself. It asks a validating resolver and
 * believes the AD flag in the reply. That is only sound when the path to the
 * resolver cannot be tampered with — loopback, in practice, which is why a local
 * unbound is the recommended setup and a non-loopback resolver is refused unless
 * `DANE_TRUST_REMOTE_RESOLVER=true`. An attacker between us and a remote resolver
 * can set AD on anything.
 *
 * ## What happens on which answer
 *
 *   - MX RRset insecure → DANE does not apply to any host (RFC 7672 §2.2.1):
 *     the MX name itself could have been substituted.
 *   - MX host's address records insecure → DANE does not apply to that host.
 *   - TLSA secure with records → enforce. None usable → STARTTLS is still
 *     mandatory, but unauthenticated (§2.2, as Postfix does).
 *   - TLSA secure NXDOMAIN/NODATA, or insecure → no DANE, opportunistic TLS.
 *   - SERVFAIL or timeout once the host's addresses were secure → that host is
 *     deferred. A validating resolver answers SERVFAIL for a bogus signature,
 *     and falling back to cleartext there is precisely the downgrade DANE exists
 *     to prevent.
 *
 * DANE outranks MTA-STS when it applies (RFC 8461 §2): a caller consulting an
 * STS policy should do so only for a host whose policy here is `none`.
 */

/** RFC 8460 result types, so a failure can be reported over TLS-RPT unchanged. */
export type TlsRptResultType =
  | "starttls-not-supported"
  | "certificate-host-mismatch"
  | "certificate-expired"
  | "certificate-not-trusted"
  | "validation-failure"
  | "tlsa-invalid"
  | "dnssec-invalid"
  | "dane-required"

/**
 * What the client concluded about transport security for one session. `outcome`
 * is `success` or the RFC 8460 failure type; it describes the policy check, not
 * whether the mail was delivered — mail can go out over unauthenticated TLS with
 * an outcome of `tlsa-invalid`.
 */
export type TlsResult = {
  policy: "dane" | "sts" | "none"
  outcome: "success" | TlsRptResultType
  reason: string
}

export type DanePolicy = {
  /** Usable records. Empty means mandatory TLS without authentication. */
  records: Tlsa[]
  /** Reference identifiers for DANE-TA name checks (§3.2.2). */
  names: string[]
  /** The TLSA base domain, sent as SNI (§8.1). */
  serverName: string
}

export type HostPolicy =
  | { kind: "none"; reason: string }
  | { kind: "dane"; policy: DanePolicy }
  | { kind: "defer"; reason: string }

// --- resolver --------------------------------------------------------------

export const parseResolver = (spec: string): Server | null => {
  const value = spec.trim()
  if (!value) return null
  const bracketed = value.match(/^\[([^\]]+)\](?::(\d+))?$/)
  if (bracketed) return { host: bracketed[1] as string, port: Number(bracketed[2] ?? 53) }
  if (isIP(value)) return { host: value, port: 53 }
  const hostPort = value.match(/^([^:]+):(\d+)$/)
  if (hostPort && isIP(hostPort[1] as string))
    return { host: hostPort[1] as string, port: Number(hostPort[2]) }
  return null
}

/** The first `nameserver` in resolv.conf, the same one the system resolver asks first. */
export const systemResolver = async (path = "/etc/resolv.conf"): Promise<Server | null> => {
  try {
    const text = await Bun.file(path).text()
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*nameserver\s+(\S+)/)
      // A scoped IPv6 address (fe80::1%en0) cannot be used from here.
      if (m && isIP(m[1] as string)) return { host: m[1] as string, port: 53 }
    }
  } catch {
    // No resolv.conf: DANE stays off.
  }
  return null
}

export const isLoopback = (host: string): boolean =>
  /^127\./.test(host) || host === "::1" || /^::ffff:127\./i.test(host)

type State = { enabled: boolean; resolver: Server | null; reason: string }

let state: State = { enabled: false, resolver: null, reason: "not probed" }

/** Whether DANE is enforced for direct MX delivery, and why. */
export const daneStatus = (): Readonly<State> => state

/** Test seam: set the decision without probing. `null` restores the unprobed default. */
export const setDane = (value: State | null): void => {
  state = value ?? { enabled: false, resolver: null, reason: "not probed" }
}

/**
 * Decides, once at startup, whether to enforce DANE.
 *
 * In `auto` the resolver has to prove it validates: a signed name must come back
 * with AD set, and a deliberately broken one (dnssec-failed.org) must not come
 * back as an answer. The second check catches a forwarder that copies AD from
 * upstream or sets it blindly, which would make every forged record look
 * authenticated. `on` skips the proof — the operator has vouched for the
 * resolver — but not the loopback rule.
 */
export const probeDane = async (
  options: { mode?: string; resolver?: string; trustRemote?: boolean; log?: boolean } = {},
): Promise<Readonly<State>> => {
  const mode = (options.mode ?? config.delivery.dane.mode).toLowerCase()
  const spec = options.resolver ?? config.delivery.dane.resolver
  const trustRemote = options.trustRemote ?? config.delivery.dane.trustRemoteResolver
  const decide = (enabled: boolean, resolver: Server | null, reason: string) => {
    state = { enabled, resolver, reason }
    if (options.log !== false)
      console.log(`[corsair] dane        ${enabled ? "on" : "off"} — ${reason}`)
    return state
  }

  if (mode === "off") return decide(false, null, "DANE=off")
  if (mode !== "on" && mode !== "auto" && mode !== "")
    return decide(false, null, `unrecognised DANE=${mode}; expected off, on, or auto`)

  const resolver = spec ? parseResolver(spec) : await systemResolver()
  if (!resolver)
    return decide(
      false,
      null,
      spec ? `DANE_RESOLVER=${spec} is not an IP address` : "no resolver found",
    )
  const where = `${resolver.host}:${resolver.port}`
  if (!isLoopback(resolver.host) && !trustRemote)
    return decide(
      false,
      resolver,
      `resolver ${where} is not on loopback; its AD bit can be forged on the way here (set DANE_TRUST_REMOTE_RESOLVER=true to accept it)`,
    )
  if (mode === "on") return decide(true, resolver, `DANE=on, resolver ${where}`)

  try {
    const signed = await query({ server: resolver, name: ".", type: TYPE.SOA, timeoutMs: 3000 })
    if (signed.rcode !== RCODE.NOERROR || !signed.flags.ad)
      return decide(
        false,
        resolver,
        `resolver ${where} does not validate DNSSEC (no AD on the root zone)`,
      )
    const bogus = await query({
      server: resolver,
      name: "dnssec-failed.org",
      type: TYPE.A,
      timeoutMs: 3000,
    }).catch(() => null)
    if (bogus && bogus.rcode === RCODE.NOERROR && bogus.answers.length)
      return decide(
        false,
        resolver,
        `resolver ${where} answered a name with a broken signature; it is not validating`,
      )
    return decide(true, resolver, `resolver ${where} validates DNSSEC`)
  } catch (e) {
    return decide(false, resolver, `resolver ${where} did not answer: ${(e as Error).message}`)
  }
}

// --- lookups ---------------------------------------------------------------

type Lookup =
  | { kind: "answer"; secure: boolean; records: Answer[]; message: Message }
  | { kind: "empty"; secure: boolean }
  | { kind: "error"; reason: string }

const lookup = async (name: string, type: number): Promise<Lookup> => {
  const resolver = state.resolver
  if (!resolver) return { kind: "error", reason: "no DANE resolver" }
  try {
    const message = await query({ server: resolver, name, type })
    const secure = message.flags.ad
    if (message.rcode === RCODE.NXDOMAIN) return { kind: "empty", secure }
    if (message.rcode !== RCODE.NOERROR)
      return { kind: "error", reason: `rcode ${message.rcode} for ${name}` }
    const records = message.answers.filter((a) => a.type === type)
    if (!records.length) return { kind: "empty", secure }
    return { kind: "answer", secure, records, message }
  } catch (e) {
    return { kind: "error", reason: `${name}: ${(e as Error).message}` }
  }
}

export type MxLookup =
  | { kind: "hosts"; hosts: string[]; secure: boolean }
  | { kind: "error"; reason: string }

/**
 * MX through the validating resolver, so its security status is known. An
 * error is reported rather than papered over with the implicit MX: if the
 * resolver cannot answer, guessing a host is how a downgrade gets in.
 */
export const secureMx = async (domain: string): Promise<MxLookup> => {
  const result = await lookup(domain, TYPE.MX)
  if (result.kind === "error") return result
  // RFC 5321 §5.1: no MX means the domain's own address records.
  if (result.kind === "empty") return { kind: "hosts", hosts: [domain], secure: result.secure }
  const hosts = result.records
    .flatMap((r) => (r.mx ? [r.mx] : []))
    .sort((a, b) => a.preference - b.preference)
    .map((m) => m.exchange.replace(/\.$/, ""))
    .filter(Boolean)
  return { kind: "hosts", hosts, secure: result.secure }
}

/**
 * RFC 7672 §3.1.3: PKIX-TA(0) and PKIX-EE(1) are unusable for SMTP, since MX
 * hosts have no common set of trusted CAs. Unknown selectors and matching types
 * are unusable too, as is a digest of the wrong length.
 */
export const usableTlsa = (records: Tlsa[]): Tlsa[] =>
  records.filter((r) => {
    if (r.usage !== 2 && r.usage !== 3) return false
    if (r.selector !== 0 && r.selector !== 1) return false
    if (r.matchingType === 0) return r.data.length > 0
    if (r.matchingType === 1) return r.data.length === 32
    if (r.matchingType === 2) return r.data.length === 64
    return false
  })

/**
 * The DANE policy for one MX host. Only called when DANE is on; `mxSecure` is
 * whether the MX RRset that named this host was authenticated.
 */
export const policyForHost = async (
  host: string,
  context: { domain: string; mxSecure: boolean },
): Promise<HostPolicy> => {
  if (!context.mxSecure) return { kind: "none", reason: "MX records are not DNSSEC-signed" }
  if (isIP(host)) return { kind: "none", reason: "MX is an address literal" }

  // §2.2.2: TLSA applies only if the host's addresses are secure too. A is
  // asked first; a host with no A is asked for AAAA.
  let address = await lookup(host, TYPE.A)
  if (address.kind === "empty" && address.secure) {
    const v6 = await lookup(host, TYPE.AAAA)
    if (v6.kind !== "empty") address = v6
  }
  if (address.kind === "error")
    return { kind: "defer", reason: `address lookup failed: ${address.reason}` }
  if (!address.secure)
    return { kind: "none", reason: `${host} address records are not DNSSEC-signed` }
  if (address.kind === "empty") return { kind: "none", reason: `${host} has no address records` }

  // §2.2.3: a secure CNAME chain makes the expanded name the first TLSA base
  // domain, with the original name as the fallback.
  let expanded = canonicalName(host)
  for (let i = 0; i < 8; i++) {
    const step = address.message.answers.find(
      (a) => a.type === TYPE.CNAME && canonicalName(a.name) === expanded,
    )
    if (!step?.target) break
    expanded = canonicalName(step.target)
  }
  const bases = expanded === canonicalName(host) ? [expanded] : [expanded, canonicalName(host)]

  for (const base of bases) {
    const tlsa = await lookup(`_25._tcp.${base}`, TYPE.TLSA)
    if (tlsa.kind === "error")
      return { kind: "defer", reason: `TLSA lookup failed: ${tlsa.reason}` }
    if (tlsa.kind === "empty" || !tlsa.secure) continue
    const records = tlsa.records.flatMap((r) => (r.tlsa ? [r.tlsa] : []))
    const names = [...new Set([...bases, canonicalName(context.domain)])]
    return { kind: "dane", policy: { records: usableTlsa(records), names, serverName: base } }
  }
  return { kind: "none", reason: `no DNSSEC-signed TLSA records for ${host}` }
}

// --- certificate matching ----------------------------------------------------

/**
 * The certificate chain the peer sent, leaf first.
 *
 * Bun's native socket inverts Node's argument: `getPeerCertificate(false)` is
 * the *unabbreviated* form, with `issuerCertificate` links, and `true` returns
 * the leaf alone. A self-signed root links to itself, which ends the walk.
 */
export const peerChain = (socket: Bun.Socket<unknown>): X509Certificate[] => {
  type Peer = { raw?: Uint8Array; issuerCertificate?: Peer }
  const chain: X509Certificate[] = []
  let current = (socket.getPeerCertificate as unknown as (abbreviated: boolean) => Peer | null)(
    false,
  )
  const seen = new Set<Peer>()
  while (current?.raw && !seen.has(current) && chain.length < 10) {
    seen.add(current)
    try {
      chain.push(new X509Certificate(Buffer.from(current.raw)))
    } catch {
      break
    }
    current = current.issuerCertificate ?? null
  }
  return chain
}

const selected = (cert: X509Certificate, selector: number): Buffer =>
  selector === 0 ? cert.raw : (cert.publicKey.export({ type: "spki", format: "der" }) as Buffer)

const digest = (data: Buffer, matchingType: number): Buffer =>
  matchingType === 1
    ? createHash("sha256").update(data).digest()
    : matchingType === 2
      ? createHash("sha512").update(data).digest()
      : data

export const certMatches = (cert: X509Certificate, record: Tlsa): boolean =>
  digest(selected(cert, record.selector), record.matchingType).equals(Buffer.from(record.data))

const describe = (r: Tlsa) => `${r.usage} ${r.selector} ${r.matchingType}`

const withinValidity = (cert: X509Certificate, now: Date): boolean =>
  new Date(cert.validFrom) <= now && now <= new Date(cert.validTo)

// Wildcards only as the whole leftmost label (§3.2.3).
const nameMatches = (leaf: X509Certificate, names: string[]): boolean =>
  names.some(
    (name) =>
      leaf.checkHost(name, {
        partialWildcards: false,
        multiLabelWildcards: false,
        singleLabelSubdomains: false,
      }) !== undefined,
  )

/** Each certificate in `chain[0..top]` is issued and signed by the next. */
const chainLinks = (chain: X509Certificate[], top: number): boolean => {
  for (let i = 0; i < top; i++) {
    const cert = chain[i] as X509Certificate
    const issuer = chain[i + 1] as X509Certificate
    if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) return false
  }
  return true
}

export type MatchResult =
  | { ok: true; reason: string }
  | { ok: false; outcome: TlsRptResultType; reason: string }

/**
 * Checks a presented chain against a DANE policy.
 *
 * DANE-EE(3) pins the leaf and nothing else: no name check, no expiry (§3.1.1),
 * because the TLSA record *is* the authority. DANE-TA(2) pins an issuer, so the
 * chain from the leaf up to it must verify, every certificate on it must be
 * current, and the leaf must name one of the reference identifiers.
 *
 * A DANE-TA record may also name a trust anchor the server does not send. That
 * can be checked only when the record holds the full public key (2 1 0): the
 * topmost certificate sent must then be signed by it. A digest of an absent
 * anchor cannot be checked at all and does not match.
 */
export const matchChain = (
  chain: X509Certificate[],
  policy: DanePolicy,
  now = new Date(),
): MatchResult => {
  const leaf = chain[0]
  if (!leaf)
    return {
      ok: false,
      outcome: "validation-failure",
      reason: "the server presented no certificate",
    }

  for (const record of policy.records) {
    if (record.usage === 3 && certMatches(leaf, record))
      return { ok: true, reason: `certificate matches TLSA ${describe(record)}` }
  }

  let failure: MatchResult | null = null
  for (const record of policy.records) {
    if (record.usage !== 2) continue
    let top = -1
    for (let i = 1; i < chain.length; i++) {
      if (certMatches(chain[i] as X509Certificate, record)) {
        top = i
        break
      }
    }
    if (top === -1 && record.selector === 1 && record.matchingType === 0) {
      let anchor: KeyObject | null = null
      try {
        anchor = createPublicKey({ key: Buffer.from(record.data), format: "der", type: "spki" })
      } catch {
        anchor = null
      }
      const last = chain.length - 1
      if (anchor && (chain[last] as X509Certificate).verify(anchor)) top = last
    }
    if (top === -1) continue
    if (!chainLinks(chain, top)) {
      failure = {
        ok: false,
        outcome: "certificate-not-trusted",
        reason: "the chain does not verify up to the TLSA trust anchor",
      }
      continue
    }
    if (!chain.slice(0, top + 1).every((c) => withinValidity(c, now))) {
      failure = {
        ok: false,
        outcome: "certificate-expired",
        reason: "a certificate in the chain is expired or not yet valid",
      }
      continue
    }
    if (!nameMatches(leaf, policy.names)) {
      failure = {
        ok: false,
        outcome: "certificate-host-mismatch",
        reason: `the certificate names none of ${policy.names.join(", ")}`,
      }
      continue
    }
    return { ok: true, reason: `chain matches TLSA ${describe(record)}` }
  }

  return (
    failure ?? {
      ok: false,
      outcome: "validation-failure",
      reason: "the certificate matches no TLSA record",
    }
  )
}
