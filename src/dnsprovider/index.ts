import { resolveNs } from "node:dns/promises"
import type { DomainRecord } from "../schema/index.ts"

/**
 * One-click DNS publishing.
 *
 * The alternative to a customer copying eleven records into a control panel by
 * hand, which is where most of them give up. Corsair detects the provider from
 * the domain's NS records and, given an API token, writes the records itself.
 *
 * **The token is never stored.** It is used for one publish and discarded. A
 * DNS API token can usually rewrite every record on every domain in an account
 * — holding one on a mail server, indefinitely, to save a customer a second
 * paste is a bad trade. This is deliberately not OAuth for the same reason:
 * OAuth here would mean a long-lived grant.
 */

export type ProviderId = "cloudflare" | "digitalocean" | "route53" | "unknown"

export type DetectedProvider = {
  id: ProviderId
  label: string
  /** True when Corsair can publish for this provider given a token. */
  automatic: boolean
  nameservers: string[]
  /** Where the customer creates a token, and what scope it needs. */
  tokenUrl?: string
  tokenHint?: string
}

const SIGNATURES: {
  id: ProviderId
  label: string
  match: RegExp
  automatic: boolean
  tokenUrl?: string
  tokenHint?: string
}[] = [
  {
    id: "cloudflare",
    label: "Cloudflare",
    match: /\bcloudflare\.com$/i,
    automatic: true,
    tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
    tokenHint: "Create a token with the Zone → DNS → Edit permission for this zone only.",
  },
  {
    id: "digitalocean",
    label: "DigitalOcean",
    match: /\bdigitalocean\.com$/i,
    automatic: true,
    tokenUrl: "https://cloud.digitalocean.com/account/api/tokens",
    tokenHint: "Create a personal access token with write scope.",
  },
  { id: "route53", label: "Amazon Route 53", match: /\bawsdns-\d+\./i, automatic: false },
]

export const detectProvider = async (domain: string): Promise<DetectedProvider> => {
  let nameservers: string[] = []
  try {
    nameservers = (await resolveNs(domain)).map((n) => n.replace(/\.$/, "").toLowerCase())
  } catch {
    // A domain whose NS records do not resolve yet is not an error here — the
    // customer may have only just registered it.
    return { id: "unknown", label: "your DNS provider", automatic: false, nameservers: [] }
  }

  for (const signature of SIGNATURES) {
    if (nameservers.some((ns) => signature.match.test(ns))) {
      return {
        id: signature.id,
        label: signature.label,
        automatic: signature.automatic,
        nameservers,
        tokenUrl: signature.tokenUrl,
        tokenHint: signature.tokenHint,
      }
    }
  }

  return { id: "unknown", label: "your DNS provider", automatic: false, nameservers }
}

// ------------------------------------------------------------- publishing --

export type PublishResult = {
  published: number
  skipped: number
  errors: { record: string; message: string }[]
}

type PublishInput = {
  domain: string
  records: DomainRecord[]
  token: string
}

/** The record name a provider wants: the bare host, or the domain for `@`. */
const hostFor = (record: DomainRecord, domain: string): string =>
  record.host === "@" || record.host === "" ? domain : `${record.host}.${domain}`

// ------------------------------------------------------------- Cloudflare --

const cloudflare = async (input: PublishInput): Promise<PublishResult> => {
  const api = "https://api.cloudflare.com/client/v4"
  const headers = {
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
  }

  const zoneResponse = await fetch(`${api}/zones?name=${encodeURIComponent(input.domain)}`, {
    headers,
  })
  const zoneBody = (await zoneResponse.json()) as {
    success?: boolean
    result?: { id: string }[]
    errors?: { message: string }[]
  }
  if (!zoneResponse.ok || !zoneBody.success) {
    throw new Error(zoneBody.errors?.[0]?.message ?? "Cloudflare rejected that token.")
  }
  const zone = zoneBody.result?.[0]?.id
  if (!zone) throw new Error(`Cloudflare has no zone for ${input.domain} on that account.`)

  const existingResponse = await fetch(`${api}/zones/${zone}/dns_records?per_page=200`, { headers })
  const existingBody = (await existingResponse.json()) as {
    result?: { id: string; type: string; name: string; content: string }[]
  }
  const existing = existingBody.result ?? []

  const result: PublishResult = { published: 0, skipped: 0, errors: [] }

  for (const record of input.records) {
    const name = hostFor(record, input.domain)
    const payload: Record<string, unknown> = {
      type: record.type,
      name,
      content: record.value,
      ttl: 1,
    }
    if (record.type === "MX") payload.priority = record.priority ?? 10

    // Update in place when a record of the same type and name already exists.
    // Creating a second SPF TXT rather than replacing the first is a permanent
    // error for the domain, not a duplicate.
    const match = existing.find(
      (e) =>
        e.type === record.type &&
        e.name.toLowerCase() === name.toLowerCase() &&
        (record.type !== "TXT" || sameTxtPurpose(e.content, record.value)),
    )

    if (match && match.content === record.value) {
      result.skipped++
      continue
    }

    const response = await fetch(
      match ? `${api}/zones/${zone}/dns_records/${match.id}` : `${api}/zones/${zone}/dns_records`,
      { method: match ? "PUT" : "POST", headers, body: JSON.stringify(payload) },
    )
    if (response.ok) {
      result.published++
      continue
    }
    const body = (await response.json().catch(() => ({}))) as { errors?: { message: string }[] }
    result.errors.push({
      record: `${record.type} ${record.host}`,
      message: body.errors?.[0]?.message ?? `HTTP ${response.status}`,
    })
  }

  return result
}

/**
 * Two TXT records on the same name are only the "same" record if they serve the
 * same purpose. An SPF record and a verification token both live at the apex
 * and must not overwrite each other.
 */
const sameTxtPurpose = (a: string, b: string): boolean => {
  const kind = (value: string) => {
    const trimmed = value.trim().toLowerCase()
    if (trimmed.startsWith("v=spf1")) return "spf"
    if (trimmed.startsWith("v=dmarc1")) return "dmarc"
    if (trimmed.startsWith("mail-host-verify=")) return "verify"
    return trimmed
  }
  return kind(a) === kind(b)
}

// ----------------------------------------------------------- DigitalOcean --

const digitalocean = async (input: PublishInput): Promise<PublishResult> => {
  const api = `https://api.digitalocean.com/v2/domains/${encodeURIComponent(input.domain)}/records`
  const headers = {
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
  }

  const existingResponse = await fetch(`${api}?per_page=200`, { headers })
  if (!existingResponse.ok) {
    throw new Error(
      existingResponse.status === 401
        ? "DigitalOcean rejected that token."
        : `DigitalOcean has no domain named ${input.domain} on that account.`,
    )
  }
  const existingBody = (await existingResponse.json()) as {
    domain_records?: { id: number; type: string; name: string; data: string }[]
  }
  const existing = existingBody.domain_records ?? []

  const result: PublishResult = { published: 0, skipped: 0, errors: [] }

  for (const record of input.records) {
    // DigitalOcean wants the bare host with "@" for the apex, and a trailing
    // dot on CNAME and MX targets.
    const name = record.host === "@" ? "@" : record.host
    const data = record.type === "CNAME" || record.type === "MX" ? `${record.value}.` : record.value

    const payload: Record<string, unknown> = { type: record.type, name, data, ttl: 3600 }
    if (record.type === "MX") payload.priority = record.priority ?? 10

    const match = existing.find(
      (e) =>
        e.type === record.type &&
        e.name === name &&
        (record.type !== "TXT" || sameTxtPurpose(e.data, record.value)),
    )

    if (match && match.data.replace(/\.$/, "") === data.replace(/\.$/, "")) {
      result.skipped++
      continue
    }

    const response = await fetch(match ? `${api}/${match.id}` : api, {
      method: match ? "PUT" : "POST",
      headers,
      body: JSON.stringify(payload),
    })
    if (response.ok) {
      result.published++
      continue
    }
    const body = (await response.json().catch(() => ({}))) as { message?: string }
    result.errors.push({
      record: `${record.type} ${record.host}`,
      message: body.message ?? `HTTP ${response.status}`,
    })
  }

  return result
}

export const publishRecords = async (
  provider: ProviderId,
  input: PublishInput,
): Promise<PublishResult> => {
  switch (provider) {
    case "cloudflare":
      return cloudflare(input)
    case "digitalocean":
      return digitalocean(input)
    default:
      throw new Error(`Corsair cannot publish records to ${provider} automatically.`)
  }
}
