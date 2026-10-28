import type { KeyObject } from "node:crypto"
import { addChallenge, removeChallenge } from "../challenge/index.ts"
import { buildCsr } from "../csr/index.ts"
import { b64url, keyAuthorization, signJws } from "../jws/index.ts"

/**
 * An RFC 8555 client, HTTP-01 only.
 *
 * TLS-ALPN-01 needs a listener on 443 answering with a special certificate,
 * which Corsair does not hold; DNS-01 needs write access to DNS, which Corsair
 * deliberately does not keep (see `core/dnsprovider`). Both are left to certbot.
 */

type Directory = {
  newNonce: string
  newAccount: string
  newOrder: string
  meta?: { termsOfService?: string }
}

type Order = {
  status: string
  authorizations: string[]
  finalize: string
  certificate?: string
  error?: unknown
}

type Challenge = { type: string; url: string; token: string; status: string; error?: unknown }

type Authorization = {
  status: string
  identifier: { type: string; value: string }
  challenges: Challenge[]
}

export type IssueOptions = {
  directoryUrl: string
  accountKey: KeyObject
  certKey: KeyObject
  email: string
  domains: string[]
  /** Floor between polls when the server sends no Retry-After. */
  pollMs?: number
  /** How long one order may take end to end. */
  timeoutMs?: number
  fetch?: typeof fetch
}

const problemType = (body: unknown): string =>
  body && typeof body === "object" && "type" in body ? String((body as { type: unknown }).type) : ""

const describe = (body: unknown): string => {
  if (body && typeof body === "object") {
    const b = body as { type?: string; detail?: string }
    return [b.type, b.detail].filter(Boolean).join(": ") || JSON.stringify(body)
  }
  return String(body)
}

/** Seconds or an HTTP date; RFC 8555 §7.4 lets the server send either. */
export const retryAfterMs = (header: string | null, floor: number): number => {
  if (!header) return floor
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now()
  // Capped: a server asking for an hour mid-order is better answered by the deadline.
  return Math.min(Math.max(Number.isFinite(ms) ? ms : floor, floor), 60_000)
}

export const issueCertificate = async (options: IssueOptions): Promise<string> => {
  const http = options.fetch ?? fetch
  const pollMs = options.pollMs ?? 2_000
  const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000)

  const dirRes = await http(options.directoryUrl)
  if (!dirRes.ok) throw new Error(`ACME directory answered ${dirRes.status}`)
  const directory = (await dirRes.json()) as Directory

  let nonce: string | null = null
  let kid: string | undefined

  const freshNonce = async (): Promise<string> => {
    const res = await http(directory.newNonce, { method: "HEAD" })
    const value = res.headers.get("replay-nonce")
    if (!value) throw new Error("ACME server returned no Replay-Nonce")
    return value
  }

  // Every response carries the next nonce, so a fresh HEAD is only needed for
  // the first request or after one that came back without it.
  const post = async (
    url: string,
    payload: unknown,
    accept?: string,
    retried = false,
  ): Promise<{ res: Response; body: unknown; text: string }> => {
    const jws = signJws({
      key: options.accountKey,
      url,
      nonce: nonce ?? (await freshNonce()),
      payload,
      ...(kid ? { kid } : {}),
    })
    nonce = null
    const res = await http(url, {
      method: "POST",
      headers: {
        "content-type": "application/jose+json",
        ...(accept ? { accept } : {}),
      },
      body: JSON.stringify(jws),
    })
    nonce = res.headers.get("replay-nonce")
    const text = await res.text()
    let body: unknown = text
    if ((res.headers.get("content-type") ?? "").includes("json")) {
      try {
        body = JSON.parse(text)
      } catch {
        // Left as text; the status decides what happens next.
      }
    }
    // RFC 8555 §6.5: a client should retry a badNonce with the nonce that came
    // back on the rejection. Once — a server that rejects twice is broken.
    if (!res.ok && !retried && problemType(body) === "urn:ietf:params:acme:error:badNonce") {
      return post(url, payload, accept, true)
    }
    if (!res.ok)
      throw new Error(`ACME ${new URL(url).pathname} answered ${res.status}: ${describe(body)}`)
    return { res, body, text }
  }

  const poll = async <T extends { status: string }>(
    url: string,
    done: (v: T) => boolean,
  ): Promise<T> => {
    for (;;) {
      const { res, body } = await post(url, null)
      const value = body as T
      if (done(value)) return value
      if (Date.now() > deadline)
        throw new Error(`ACME ${url} still ${value.status} at the deadline`)
      await Bun.sleep(retryAfterMs(res.headers.get("retry-after"), pollMs))
    }
  }

  // newAccount with an existing key returns that account (200, same Location),
  // so there is no account URL to store and no state to get out of sync.
  const account = await post(directory.newAccount, {
    termsOfServiceAgreed: true,
    contact: [`mailto:${options.email}`],
  })
  kid = account.res.headers.get("location") ?? undefined
  if (!kid) throw new Error("ACME newAccount returned no account URL")

  const created = await post(directory.newOrder, {
    identifiers: options.domains.map((value) => ({ type: "dns", value })),
  })
  const orderUrl = created.res.headers.get("location")
  if (!orderUrl) throw new Error("ACME newOrder returned no order URL")
  let order = created.body as Order

  const tokens: string[] = []
  try {
    for (const authzUrl of order.authorizations) {
      const authz = (await post(authzUrl, null)).body as Authorization
      if (authz.status === "valid") continue
      const challenge = authz.challenges.find((c) => c.type === "http-01")
      if (!challenge) {
        throw new Error(`No http-01 challenge offered for ${authz.identifier.value}`)
      }
      addChallenge(challenge.token, keyAuthorization(challenge.token, options.accountKey))
      tokens.push(challenge.token)
      await post(challenge.url, {})
      const settled = await poll<Authorization>(
        authzUrl,
        (a) => a.status !== "pending" && a.status !== "processing",
      )
      if (settled.status !== "valid") {
        const failed = settled.challenges.find((c) => c.type === "http-01")
        throw new Error(
          `Validation of ${authz.identifier.value} failed: ${describe(failed?.error ?? settled.status)}`,
        )
      }
    }
  } finally {
    for (const t of tokens) removeChallenge(t)
  }

  order = await poll<Order>(orderUrl, (o) => o.status !== "pending")
  if (order.status === "ready") {
    const csr = buildCsr(options.domains, options.certKey)
    await post(order.finalize, { csr: b64url(csr) })
    order = await poll<Order>(orderUrl, (o) => o.status !== "processing" && o.status !== "ready")
  }
  if (order.status !== "valid" || !order.certificate) {
    throw new Error(`ACME order ended ${order.status}: ${describe(order.error ?? "")}`)
  }

  const cert = await post(order.certificate, null, "application/pem-certificate-chain")
  if (!cert.text.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error("ACME certificate download was not a PEM chain")
  }
  return cert.text
}
