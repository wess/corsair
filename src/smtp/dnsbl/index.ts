import { Resolver } from "node:dns/promises"
import { isIP } from "node:net"
import { config } from "../../config/index.ts"
import { groupsV6, isPublicAddress } from "../../safefetch/index.ts"

/**
 * DNS blocklists: the connecting IP against IP lists, and the sender's and the
 * body links' domains against domain lists.
 *
 * A listing is a fact somebody else published, not a heuristic, but it is still
 * fed into the score rather than acted on by default — see `SPAM_DNSBL_REJECT`.
 *
 * The thing that bites: Spamhaus does not answer queries from public or cloud
 * resolvers with an error. It answers with an address in 127.255.255.0/24, which
 * looks exactly like a listing to anything that only asks "did it resolve?". Read
 * that way, every message from every sender is blocklisted. So only the return
 * codes each list documents count, the 127.255.255.x codes mean "no answer", and
 * an answer outside 127.0.0.0/24 and 127.0.1.0/24 — an ISP resolver rewriting
 * NXDOMAIN to its search page — means nothing at all.
 */

export type ListKind = "ip" | "domain"

export type Listing = {
  zone: string
  kind: ListKind
  /** The IP or domain that is listed. */
  subject: string
  code: string
  category: string
  points: number
  /** Whether `SPAM_DNSBL_REJECT` may refuse the session over it. */
  reject: boolean
}

export type Classified =
  | { kind: "listed"; listings: Listing[] }
  | { kind: "clean" }
  | { kind: "refused"; code: string }

type Code = { category: string; points: number; reject: boolean }

// SBL, CSS, DROP and XBL are about the host itself: a spam operation, a snowshoe
// range, hijacked space, an infected machine. PBL only says the range is not
// meant to send mail directly — strong on port 25, and meaningless for anything
// relayed, which is why only the connecting IP is ever checked.
//
// The host listings and the malicious-link listings are worth more than every
// authentication bonus together (-4), so each files mail in Junk on its own:
// SPF and DKIM prove whose mail it is, and a spam operation authenticates its
// own domain like anyone else. PBL is not, on purpose — a self-hoster on a
// residential line who publishes SPF and signs is exactly who PBL catches, and
// their mail should arrive.
const ZEN: Record<string, Code> = {
  "127.0.0.2": { category: "SBL", points: 9, reject: true },
  "127.0.0.3": { category: "SBL CSS", points: 5, reject: true },
  "127.0.0.4": { category: "XBL", points: 9, reject: true },
  "127.0.0.5": { category: "XBL", points: 9, reject: true },
  "127.0.0.6": { category: "XBL", points: 9, reject: true },
  "127.0.0.7": { category: "XBL", points: 9, reject: true },
  "127.0.0.9": { category: "SBL DROP", points: 9, reject: true },
  "127.0.0.10": { category: "PBL", points: 3, reject: false },
  "127.0.0.11": { category: "PBL", points: 3, reject: false },
}

// The 1xx codes are legitimate domains that have been abused — a compromised
// site, a link shortener. A link to one is a much weaker signal than a link to a
// domain registered for spam.
const DBL: Record<string, Code> = {
  "127.0.1.2": { category: "DBL spam domain", points: 6, reject: false },
  "127.0.1.4": { category: "DBL phishing domain", points: 9, reject: false },
  "127.0.1.5": { category: "DBL malware domain", points: 9, reject: false },
  "127.0.1.6": { category: "DBL botnet C&C domain", points: 9, reject: false },
  "127.0.1.102": { category: "DBL abused legit spam", points: 1.5, reject: false },
  "127.0.1.103": { category: "DBL abused redirector", points: 1.5, reject: false },
  "127.0.1.104": { category: "DBL abused legit phish", points: 1.5, reject: false },
  "127.0.1.105": { category: "DBL abused legit malware", points: 1.5, reject: false },
  "127.0.1.106": { category: "DBL abused legit botnet C&C", points: 1.5, reject: false },
}

const GENERIC: Code = { category: "listed", points: 3, reject: false }

const isSpamhaus = (zone: string): boolean => /(^|\.)spamhaus\.(org|net)$/i.test(zone)

/**
 * What one list's answer means. Exported for the tests, which are the only way
 * to pin the refusal codes without a resolver Spamhaus refuses.
 */
export const classify = (
  zone: string,
  kind: ListKind,
  subject: string,
  answers: readonly string[],
): Classified => {
  const spamhaus = isSpamhaus(zone)
  const listings = new Map<string, Listing>()

  for (const code of answers) {
    // 127.255.255.252 typo in the zone, .254 public resolver, .255 rate limit.
    if (code.startsWith("127.255.255.")) return { kind: "refused", code }
    // DBL answers .255 to an IP asked as a domain; URIBL answers 127.0.0.1 to a
    // resolver it has blocked.
    if (spamhaus && code === "127.0.1.255") return { kind: "refused", code }
    if (!spamhaus && code === "127.0.0.1") return { kind: "refused", code }

    let meaning: Code | undefined
    if (spamhaus) meaning = kind === "ip" ? ZEN[code] : DBL[code]
    else if (/^127\.0\.0\.\d+$/.test(code)) meaning = GENERIC
    if (!meaning || listings.has(meaning.category)) continue
    listings.set(meaning.category, { zone, kind, subject, code, ...meaning })
  }

  return listings.size ? { kind: "listed", listings: [...listings.values()] } : { kind: "clean" }
}

// query names

/** The IPv4 address, unwrapping `::ffff:a.b.c.d` — a mapped client is an IPv4 client. */
export const ipv4Of = (ip: string): string | null => {
  if (isIP(ip) === 4) return ip
  const g = isIP(ip) === 6 ? groupsV6(ip) : null
  if (!g?.slice(0, 5).every((x) => x === 0) || g[5] !== 0xffff) return null
  const [hi = 0, lo = 0] = g.slice(6)
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`
}

/** The label sequence an IP is looked up under: octets or nibbles, reversed. */
export const reverseIp = (ip: string): string | null => {
  const four = ipv4Of(ip)
  if (four) return four.split(".").reverse().join(".")
  const g = groupsV6(ip)
  if (!g) return null
  return g
    .flatMap((group) => group.toString(16).padStart(4, "0").split(""))
    .reverse()
    .join(".")
}

// domains

// RFC 2606 and RFC 6761 names. Nothing lists them, and tests use them.
const RESERVED = /(^|\.)(test|example|invalid|localhost|local|example\.(com|net|org))$/

const hostOf = (raw: string): string | null => {
  const host = raw.toLowerCase().replace(/\.+$/, "")
  if (!host.includes(".") || host.length > 253) return null
  if (isIP(host)) return null
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) return null
  if (RESERVED.test(host)) return null
  return host
}

/**
 * The registered domain, guessed without a public-suffix list: the last two
 * labels, or three when the last two look like `co.uk`. A wrong guess costs one
 * query to a name nobody lists, which is why a full list is not worth carrying.
 */
export const baseDomain = (host: string): string => {
  const labels = host.split(".")
  if (labels.length <= 2) return host
  const tld = labels[labels.length - 1]!
  const second = labels[labels.length - 2]!
  const take = tld.length === 2 && second.length <= 3 ? 3 : 2
  return labels.slice(-take).join(".")
}

/** Bodies are scanned only this far; a link past it is not worth a lookup. */
const SCAN_CHARS = 512 * 1024

/** The most names one message may look up, across every domain list. */
export const MAX_DOMAINS = 20

const URL_HOST = /\bhttps?:\/\/(?:[^\s/?#@"'<>]*@)?([a-z0-9.-]+)/gi

/**
 * The domains worth asking about, in order: the sender's, then every link host
 * in the bodies. Each host contributes its registered domain and, when
 * different, itself — DBL lists both. Bounded by `limit`, and by `SCAN_CHARS` of
 * each body, so a message of ten thousand links costs what one of twenty does.
 */
export const extractDomains = (
  input: { senders: readonly (string | null | undefined)[]; text: string; html: string },
  limit = MAX_DOMAINS,
): string[] => {
  const out = new Set<string>()
  const add = (raw: string): boolean => {
    const host = hostOf(raw)
    if (host) {
      for (const name of [baseDomain(host), host]) {
        if (out.size >= limit) return false
        out.add(name)
      }
    }
    return out.size < limit
  }

  for (const sender of input.senders) if (sender && !add(sender)) return [...out]
  for (const body of [input.html, input.text]) {
    for (const match of body.slice(0, SCAN_CHARS).matchAll(URL_HOST)) {
      if (!add(match[1] ?? "")) return [...out]
    }
  }
  return [...out]
}

// lookups

export type Resolve = (name: string) => Promise<string[]>

export type Options = {
  zones?: readonly string[]
  resolve?: Resolve
  /** Total time for every query of one call, in parallel. */
  budgetMs?: number
}

/** Blocklist lookups must not hold a delivery up for longer than this. */
export const BUDGET_MS = 1500

let system: Resolve | null = null

const systemResolve = (): Resolve => {
  if (system) return system
  const resolver = new Resolver({ timeout: BUDGET_MS, tries: 1 })
  if (config.spam.resolver.length) resolver.setServers(config.spam.resolver)
  system = async (name) => {
    try {
      return await resolver.resolve4(name)
    } catch (e) {
      const code = (e as { code?: string }).code
      // Not listed. Anything else is a failure to ask, and is not cached.
      if (code === "ENOTFOUND" || code === "ENODATA") return []
      throw e
    }
  }
  return system
}

// A listing changes on the order of hours, and one spam run sends the same
// links from the same IPs thousands of times.
const CACHE_MS = 10 * 60 * 1000
const CACHE_MAX = 10_000
const cache = new Map<string, { at: number; answers: string[] }>()

const cached = async (name: string, resolve: Resolve): Promise<string[] | null> => {
  const hit = cache.get(name)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.answers
  try {
    const answers = await resolve(name)
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!)
    cache.set(name, { at: Date.now(), answers })
    return answers
  } catch {
    return null
  }
}

/** For tests: answers from one stub resolver must not leak into the next. */
export const clearCache = (): void => cache.clear()

const warned = new Set<string>()

const warnRefused = (zone: string, code: string): void => {
  if (warned.has(zone)) return
  warned.add(zone)
  console.warn(
    `[corsair] ${zone} refused a query (answered ${code}). That is not a listing: the list will not answer this resolver, so it is being ignored. Spamhaus refuses public and cloud resolvers — run a local recursive resolver and set SPAM_RESOLVER=127.0.0.1.`,
  )
}

const within = <T>(work: Promise<T>, deadline: number): Promise<T | null> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })

const query = async (
  zones: readonly string[],
  kind: ListKind,
  subjects: readonly { subject: string; name: string }[],
  options: Options,
): Promise<Listing[]> => {
  const resolve = options.resolve ?? systemResolve()
  const deadline = Date.now() + (options.budgetMs ?? BUDGET_MS)
  const results = await Promise.all(
    zones.flatMap((zone) =>
      subjects.map(async ({ subject, name }) => {
        const answers = await within(cached(`${name}.${zone}`, resolve), deadline)
        if (!answers) return []
        const verdict = classify(zone, kind, subject, answers)
        if (verdict.kind === "refused") warnRefused(zone, verdict.code)
        return verdict.kind === "listed" ? verdict.listings : []
      }),
    ),
  )
  return results.flat()
}

/**
 * The connecting client against the IP lists. Never called for a private or
 * loopback address, which no public list can say anything about — behind the
 * terminator that is every session until XCLIENT names the real client.
 */
export const checkIp = (ip: string, options: Options = {}): Promise<Listing[]> => {
  const zones = options.zones ?? config.spam.dnsbl
  const reversed = reverseIp(ip)
  if (!zones.length || !reversed || !isPublicAddress(ip)) return Promise.resolve([])
  return query(zones, "ip", [{ subject: ipv4Of(ip) ?? ip, name: reversed }], options)
}

export const checkDomains = (
  domains: readonly string[],
  options: Options = {},
): Promise<Listing[]> => {
  const zones = options.zones ?? config.spam.uribl
  if (!zones.length || !domains.length) return Promise.resolve([])
  return query(
    zones,
    "domain",
    domains.map((d) => ({ subject: d, name: d })),
    options,
  )
}

/** The listing that justifies refusing the client, if rejection is on. */
export const rejectable = (listings: readonly Listing[]): Listing | null =>
  listings.find((l) => l.kind === "ip" && l.reject) ?? null
