import { resolve4, resolve6, resolveMx, resolveTxt } from "node:dns/promises"

export type SpfResult =
  | "pass"
  | "fail"
  | "softfail"
  | "neutral"
  | "none"
  | "permerror"
  | "temperror"

export type SpfOutcome = { result: SpfResult; domain: string; explanation?: string }

/**
 * RFC 7208 limits an evaluation to ten DNS-querying mechanisms. It is not a
 * performance guideline — without it, a crafted record turns any receiver into
 * an amplifier — so the budget is threaded through every recursion and a domain
 * that blows it is a permerror.
 */
const LOOKUP_LIMIT = 10

type Budget = { used: number }

const spfRecordOf = async (domain: string): Promise<string | null> => {
  try {
    const records = await resolveTxt(domain)
    const joined = records.map((chunks) => chunks.join(""))
    const spf = joined.filter((r) => /^v=spf1(\s|$)/i.test(r.trim()))
    // More than one SPF record is a permerror, not a "pick the first".
    if (spf.length !== 1) return spf.length === 0 ? null : "__multiple__"
    return spf[0]!.trim()
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === "ENOTFOUND" || code === "ENODATA") return null
    throw e
  }
}

// -------------------------------------------------------------- addresses --

const ip4ToInt = (ip: string): number | null => {
  const parts = ip.split(".")
  if (parts.length !== 4) return null
  let out = 0
  for (const part of parts) {
    const n = Number(part)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    out = (out << 8) | n
  }
  return out >>> 0
}

const ip4InCidr = (ip: string, network: string, bits: number): boolean => {
  const a = ip4ToInt(ip)
  const b = ip4ToInt(network)
  if (a === null || b === null) return false
  if (bits <= 0) return true
  if (bits > 32) return false
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0
  return (a & mask) >>> 0 === (b & mask) >>> 0
}

const expandIp6 = (ip: string): bigint | null => {
  const cleaned = ip.split("%")[0] ?? ip
  const halves = cleaned.split("::")
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0]!.split(":").filter(Boolean) : []
  const tail = halves[1] !== undefined ? halves[1]!.split(":").filter(Boolean) : []
  // An embedded IPv4 tail ("::ffff:1.2.3.4") counts as two groups.
  const last = tail[tail.length - 1] ?? head[head.length - 1]
  if (last?.includes(".")) {
    const asInt = ip4ToInt(last)
    if (asInt === null) return null
    const hi = ((asInt >>> 16) & 0xffff).toString(16)
    const lo = (asInt & 0xffff).toString(16)
    if (tail.length) tail.splice(-1, 1, hi, lo)
    else head.splice(-1, 1, hi, lo)
  }
  const missing = 8 - head.length - tail.length
  if (missing < 0) return null
  if (halves.length === 1 && missing !== 0) return null
  const groups = [...head, ...Array(missing).fill("0"), ...tail]
  let out = 0n
  for (const g of groups) {
    const n = Number.parseInt(g || "0", 16)
    if (Number.isNaN(n) || n < 0 || n > 0xffff) return null
    out = (out << 16n) | BigInt(n)
  }
  return out
}

const ip6InCidr = (ip: string, network: string, bits: number): boolean => {
  const a = expandIp6(ip)
  const b = expandIp6(network)
  if (a === null || b === null) return false
  if (bits <= 0) return true
  if (bits > 128) return false
  const mask = ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits)
  return (a & mask) === (b & mask)
}

const isIp6 = (ip: string): boolean => ip.includes(":")

/**
 * Exported because the same containment test is what the submission listener
 * uses to decide whether a client is on a trusted network, and because getting
 * it wrong means accepting forged mail — it deserves its own tests.
 */
export const ipInCidr = (ip: string, network: string, bits: number): boolean =>
  isIp6(network) ? ip6InCidr(ip, network, bits) : ip4InCidr(ip, network, bits)

const matchesIp = (ip: string, candidate: string, bits?: number): boolean =>
  isIp6(ip)
    ? isIp6(candidate) && ip6InCidr(ip, candidate, bits ?? 128)
    : !isIp6(candidate) && ip4InCidr(ip, candidate, bits ?? 32)

// --------------------------------------------------------------- macros --

/**
 * Only the macros that appear in real records are expanded: %{s} %{l} %{o} %{d}
 * %{i} plus the literals. The transformers (digits, reverse, delimiters) are
 * supported because `exists:` records use them.
 */
const expandMacros = (
  input: string,
  ctx: { sender: string; domain: string; ip: string; helo: string },
): string => {
  if (!input.includes("%")) return input
  const at = ctx.sender.lastIndexOf("@")
  const localPart = at === -1 ? "postmaster" : ctx.sender.slice(0, at)
  const senderDomain = at === -1 ? ctx.sender : ctx.sender.slice(at + 1)

  return input.replace(/%(\{[^}]+\}|%|_|-)/g, (_, token: string) => {
    if (token === "%") return "%"
    if (token === "_") return " "
    if (token === "-") return "%20"
    const body = token.slice(1, -1)
    const letter = body[0]?.toLowerCase() ?? ""
    const rest = body.slice(1)
    const reverse = /r/i.test(rest)
    const digits = Number.parseInt(rest.match(/^\d+/)?.[0] ?? "0", 10)
    const delimiters = rest.replace(/^\d*/, "").replace(/r/i, "") || "."

    const base = (() => {
      switch (letter) {
        case "s":
          return ctx.sender
        case "l":
          return localPart
        case "o":
          return senderDomain
        case "d":
          return ctx.domain
        case "i":
          return ctx.ip
        case "h":
          return ctx.helo
        case "v":
          return isIp6(ctx.ip) ? "ip6" : "in-addr"
        default:
          return ""
      }
    })()

    let parts = base.split(new RegExp(`[${delimiters.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}]`))
    if (reverse) parts = parts.reverse()
    if (digits > 0) parts = parts.slice(-digits)
    return parts.join(".")
  })
}

// -------------------------------------------------------------- evaluate --

type Qualifier = "+" | "-" | "~" | "?"

const qualifierResult = (q: Qualifier): SpfResult =>
  q === "+" ? "pass" : q === "-" ? "fail" : q === "~" ? "softfail" : "neutral"

const resolveA = async (name: string, wantV6: boolean): Promise<string[]> => {
  try {
    return wantV6 ? await resolve6(name) : await resolve4(name)
  } catch {
    return []
  }
}

const evaluate = async (
  domain: string,
  ctx: { ip: string; sender: string; helo: string },
  budget: Budget,
  seen: Set<string>,
): Promise<SpfOutcome> => {
  if (seen.has(domain.toLowerCase())) {
    return { result: "permerror", domain, explanation: "include loop" }
  }
  seen.add(domain.toLowerCase())

  let record: string | null
  try {
    record = await spfRecordOf(domain)
  } catch {
    return { result: "temperror", domain, explanation: "DNS lookup failed" }
  }
  if (record === null) return { result: "none", domain }
  if (record === "__multiple__") {
    return { result: "permerror", domain, explanation: "more than one SPF record" }
  }

  const terms = record.split(/\s+/).slice(1).filter(Boolean)
  let redirect: string | null = null

  for (const term of terms) {
    const modifier = term.match(/^([a-z0-9-]+)=(.*)$/i)
    if (modifier) {
      if (modifier[1]!.toLowerCase() === "redirect") redirect = modifier[2]!
      continue
    }

    const qualifier = ("+-~?".includes(term[0]!) ? term[0]! : "+") as Qualifier
    const rest = "+-~?".includes(term[0]!) ? term.slice(1) : term

    // name[:argument][/v4-prefix][//v6-prefix] — the dual-CIDR form is why this
    // is one regex rather than a pair of indexOf calls.
    const parts = rest.match(/^([^:/]+)(?::([^/]*))?(?:\/(\d+))?(?:\/\/(\d+))?$/)
    if (!parts) return { result: "permerror", domain, explanation: `unparsable term: ${term}` }

    const mechanism = parts[1]!.toLowerCase()
    const argument = parts[2] ? expandMacros(parts[2], { ...ctx, domain }) : ""
    const v4bits = parts[3]
    const v6bits = parts[4]

    const spend = (): boolean => {
      budget.used++
      return budget.used <= LOOKUP_LIMIT
    }

    switch (mechanism) {
      case "all":
        return { result: qualifierResult(qualifier), domain }

      case "ip4": {
        if (!isIp6(ctx.ip) && ip4InCidr(ctx.ip, argument, v4bits ? Number(v4bits) : 32)) {
          return { result: qualifierResult(qualifier), domain }
        }
        break
      }

      case "ip6": {
        // ip6 carries its prefix in the first slash group, not the second.
        if (isIp6(ctx.ip) && ip6InCidr(ctx.ip, argument, v4bits ? Number(v4bits) : 128)) {
          return { result: qualifierResult(qualifier), domain }
        }
        break
      }

      case "a": {
        if (!spend()) return { result: "permerror", domain, explanation: "too many DNS lookups" }
        const target = argument || domain
        const bits = isIp6(ctx.ip) ? Number(v6bits ?? 128) : Number(v4bits ?? 32)
        const addrs = await resolveA(target, isIp6(ctx.ip))
        if (addrs.some((a) => matchesIp(ctx.ip, a, bits))) {
          return { result: qualifierResult(qualifier), domain }
        }
        break
      }

      case "mx": {
        if (!spend()) return { result: "permerror", domain, explanation: "too many DNS lookups" }
        const target = argument || domain
        const bits = isIp6(ctx.ip) ? Number(v6bits ?? 128) : Number(v4bits ?? 32)
        let hosts: { exchange: string }[] = []
        try {
          hosts = await resolveMx(target)
        } catch {
          hosts = []
        }
        // Each MX host resolved counts against the same budget.
        let matched = false
        for (const host of hosts.slice(0, LOOKUP_LIMIT)) {
          if (!spend()) return { result: "permerror", domain, explanation: "too many DNS lookups" }
          const addrs = await resolveA(host.exchange, isIp6(ctx.ip))
          if (addrs.some((a) => matchesIp(ctx.ip, a, bits))) {
            matched = true
            break
          }
        }
        if (matched) return { result: qualifierResult(qualifier), domain }
        break
      }

      case "exists": {
        if (!spend()) return { result: "permerror", domain, explanation: "too many DNS lookups" }
        const addrs = await resolveA(argument || domain, false)
        if (addrs.length) return { result: qualifierResult(qualifier), domain }
        break
      }

      case "include": {
        if (!spend()) return { result: "permerror", domain, explanation: "too many DNS lookups" }
        const inner = await evaluate(argument, ctx, budget, new Set(seen))
        // An include only contributes when it passes; every other result means
        // "keep going", except the errors, which propagate.
        if (inner.result === "pass") return { result: qualifierResult(qualifier), domain }
        if (inner.result === "temperror" || inner.result === "permerror") return inner
        break
      }

      case "ptr":
        // Deprecated by RFC 7208 §5.5 and ignored by most receivers. Spending a
        // lookup on it keeps the budget honest without acting on the result.
        if (!spend()) return { result: "permerror", domain, explanation: "too many DNS lookups" }
        break

      default:
        return { result: "permerror", domain, explanation: `unknown mechanism: ${mechanism}` }
    }
  }

  if (redirect) {
    if (budget.used++ >= LOOKUP_LIMIT) {
      return { result: "permerror", domain, explanation: "too many DNS lookups" }
    }
    return evaluate(expandMacros(redirect, { ...ctx, domain }), ctx, budget, seen)
  }

  // No mechanism matched and no explicit `all`.
  return { result: "neutral", domain }
}

/**
 * Checks the connecting IP against the envelope sender's SPF policy. An empty
 * MAIL FROM (a bounce) is checked against the HELO name instead, which is the
 * only identity such a message has.
 */
export const checkSpf = async (input: {
  ip: string
  mailFrom: string
  helo: string
}): Promise<SpfOutcome> => {
  const sender = input.mailFrom || `postmaster@${input.helo}`
  const at = sender.lastIndexOf("@")
  const domain = (at === -1 ? input.helo : sender.slice(at + 1)).toLowerCase()
  if (!domain) return { result: "none", domain: "" }

  try {
    return await evaluate(
      domain,
      { ip: input.ip, sender, helo: input.helo },
      { used: 0 },
      new Set(),
    )
  } catch (e) {
    return { result: "temperror", domain, explanation: (e as Error).message }
  }
}

// ---------------------------------------------------------------- DMARC --

export type DmarcPolicy = {
  policy: "none" | "quarantine" | "reject"
  subdomainPolicy: "none" | "quarantine" | "reject" | null
  adkim: "strict" | "relaxed"
  aspf: "strict" | "relaxed"
  percent: number
  rua: string[]
}

export const lookupDmarc = async (domain: string): Promise<DmarcPolicy | null> => {
  const read = async (name: string): Promise<string | null> => {
    try {
      const records = await resolveTxt(`_dmarc.${name}`)
      return records.map((c) => c.join("")).find((r) => /^v=DMARC1/i.test(r.trim())) ?? null
    } catch {
      return null
    }
  }

  // A subdomain with no record inherits the organisational domain's policy.
  let record = await read(domain)
  if (!record) {
    const parts = domain.split(".")
    if (parts.length > 2) record = await read(parts.slice(-2).join("."))
  }
  if (!record) return null

  const tags: Record<string, string> = {}
  for (const part of record.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    tags[part.slice(0, eq).trim().toLowerCase()] = part.slice(eq + 1).trim()
  }

  const asPolicy = (v: string | undefined) =>
    v === "reject" || v === "quarantine" || v === "none" ? v : null

  return {
    policy: asPolicy(tags.p) ?? "none",
    subdomainPolicy: asPolicy(tags.sp),
    adkim: tags.adkim === "s" ? "strict" : "relaxed",
    aspf: tags.aspf === "s" ? "strict" : "relaxed",
    percent: Number(tags.pct ?? "100"),
    rua: (tags.rua ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  }
}

export const spfAligned = (
  fromDomain: string,
  envelopeDomain: string,
  mode: "strict" | "relaxed" = "relaxed",
): boolean => {
  const a = fromDomain.toLowerCase()
  const b = envelopeDomain.toLowerCase()
  if (a === b) return true
  if (mode === "strict") return false
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`)
}
