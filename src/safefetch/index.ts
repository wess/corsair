import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { config } from "../config/index.ts"

/**
 * Fetching a URL somebody else chose.
 *
 * A webhook URL is attacker-supplied and this server fetches it from inside its
 * own network, which makes it a request-forgery primitive unless the *address*
 * it reaches is checked. Checking the hostname string is not that: a public name
 * can resolve to 127.0.0.1, `[::ffff:127.0.0.1]` is loopback spelled in a way a
 * string match never sees, and a redirect from an allowed URL can point anywhere.
 * So this resolves the name, judges every address it resolves to, and refuses to
 * follow redirects.
 *
 * The connection uses that checked address, with the original Host and TLS
 * server name, so a second DNS answer cannot redirect it inside the network.
 */

const octets = (ip: string): number[] | null => {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN))
  return nums.every((n) => n >= 0 && n <= 255) ? nums : null
}

const publicV4 = (ip: string): boolean => {
  const o = octets(ip)
  if (!o) return false
  const [a, b, c] = o as [number, number, number]
  if (a === 0 || a === 10 || a === 127) return false
  if (a === 100 && b >= 64 && b <= 127) return false // carrier-grade NAT
  if (a === 169 && b === 254) return false // link-local, including cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false
  if (a === 192 && b === 168) return false
  if (a === 192 && b === 0 && c === 0) return false
  if (a === 192 && b === 0 && c === 2) return false
  if (a === 198 && (b === 18 || b === 19)) return false // benchmarking
  if (a === 198 && b === 51 && c === 100) return false
  if (a === 203 && b === 0 && c === 113) return false
  if (a >= 224) return false // multicast and reserved, including broadcast
  return true
}

/** The eight 16-bit groups of an IPv6 address, or null if it does not parse. */
const groupsV6 = (ip: string): number[] | null => {
  let text = ip.toLowerCase()
  const zone = text.indexOf("%")
  if (zone !== -1) text = text.slice(0, zone)

  // An embedded dotted IPv4 tail (::ffff:127.0.0.1) is two groups.
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const o = octets(dotted[2]!)
    if (!o) return null
    text = `${dotted[1]}${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`
  }

  const halves = text.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(":") : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : missing < 0) return null

  const all = halves.length === 1 ? head : [...head, ...Array(missing).fill("0"), ...tail]
  const groups = all.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? Number.parseInt(g, 16) : Number.NaN))
  return groups.every((g) => !Number.isNaN(g)) ? groups : null
}

const publicV6 = (ip: string): boolean => {
  const g = groupsV6(ip)
  if (!g) return false
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  const embedded = `${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`

  if (g.every((x) => x === 0)) return false // ::
  if (
    g0 === 0 &&
    g1 === 0 &&
    g2 === 0 &&
    g3 === 0 &&
    g4 === 0 &&
    g5 === 0 &&
    g6 === 0 &&
    g7 === 1
  ) {
    return false // ::1
  }
  // IPv4-mapped (::ffff:a.b.c.d), IPv4-compatible (::a.b.c.d), and NAT64
  // (64:ff9b::a.b.c.d): all carry an IPv4 address that has to pass on its own.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) {
    return publicV4(embedded)
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return publicV4(embedded)
  }
  if ((g0 & 0xfe00) === 0xfc00) return false // unique local, fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false // link-local, fe80::/10
  if ((g0 & 0xffc0) === 0xfec0) return false // site-local, deprecated
  if ((g0 & 0xff00) === 0xff00) return false // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false // documentation
  if (g0 === 0x2002 || (g0 === 0x2001 && g1 === 0)) return false // transition tunnels
  return (g0 & 0xe000) === 0x2000 // global unicast only
}

/** Whether an IP literal is somewhere on the public internet. */
export const isPublicAddress = (ip: string): boolean => {
  const bare = ip.replace(/^\[|\]$/g, "")
  const kind = isIP(bare)
  if (kind === 4) return publicV4(bare)
  if (kind === 6) return publicV6(bare)
  return false
}

/**
 * Throws unless every address the host resolves to is public.
 *
 * *Every* address, not the first: a name with one public and one private record
 * is answered with either, and the attacker chooses which by timing.
 */
export const resolvePublicHost = async (
  hostname: string,
  allowPrivate: boolean = config.webhookAllowPrivate,
): Promise<string> => {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (!allowPrivate && (host === "localhost" || host.endsWith(".localhost"))) {
    throw new Error("That address is on a private or loopback network.")
  }

  if (isIP(host)) {
    if (!allowPrivate && !isPublicAddress(host))
      throw new Error("That address is on a private or loopback network.")
    return host
  }

  let addresses: { address: string }[]
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new Error("That host name does not resolve.")
  }
  if (!addresses.length || (!allowPrivate && !addresses.every((a) => isPublicAddress(a.address)))) {
    throw new Error("That host resolves to a private or loopback network.")
  }
  return addresses.find((a) => isIP(a.address) === 4)?.address ?? addresses[0]!.address
}

export const assertPublicHost = async (
  hostname: string,
  allowPrivate = config.webhookAllowPrivate,
): Promise<void> => {
  await resolvePublicHost(hostname, allowPrivate)
}

/**
 * `fetch` for a URL somebody else chose: the host is checked first, and a
 * redirect is returned rather than followed — a webhook endpoint that wants to
 * move says so with a 3xx and the sender treats it as a failure, which is also
 * what Stripe and GitHub do.
 */
export const safeFetch = async (
  url: string,
  init: RequestInit = {},
  allowPrivate: boolean = config.webhookAllowPrivate,
): Promise<Response> => {
  const original = new URL(url)
  if (!["http:", "https:"].includes(original.protocol) || original.username || original.password)
    throw new Error("Only HTTP and HTTPS URLs without embedded credentials are allowed.")
  const address = await resolvePublicHost(original.hostname, allowPrivate)
  const target = new URL(original)
  target.hostname = isIP(address) === 6 ? `[${address}]` : address
  const headers = new Headers(init.headers)
  headers.set("host", original.host)
  return fetch(target, {
    ...init,
    headers,
    tls: { serverName: original.hostname.replace(/^\[|\]$/g, ""), rejectUnauthorized: true },
    // the runtime accepts false; the pinned type package omits it
    proxy: false as never,
    redirect: "manual",
  })
}
