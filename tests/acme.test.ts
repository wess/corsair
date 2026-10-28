import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import {
  createHash,
  createPublicKey,
  type KeyObject,
  sign,
  verify,
  X509Certificate,
} from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addChallenge,
  removeChallenge,
  startChallengeListener,
} from "../src/acme/challenge/index.ts"
import { retryAfterMs } from "../src/acme/client/index.ts"
import { buildCsr } from "../src/acme/csr/index.ts"
import {
  bits,
  context,
  integer,
  octets,
  oid,
  pem,
  sequence,
  set,
  tlv,
  utf8,
} from "../src/acme/der/index.ts"
import {
  type AcmeSettings,
  backoffMs,
  checkCertificate,
  renewalReason,
  settingsProblems,
} from "../src/acme/index.ts"
import { generateKey, type Jwk, publicJwk, signJws, thumbprint } from "../src/acme/jws/index.ts"
import { certificateFile, type StoredCertificate } from "../src/acme/store/index.ts"
import { buildFetch } from "../src/api/index.ts"
import { currentTls, serveImplicitTls } from "../src/tls/index.ts"

const DAY = 86_400_000

describe("der", () => {
  const hex = (b: Uint8Array) => Buffer.from(b).toString("hex")

  test("integers are minimal and never negative", () => {
    expect(hex(integer(0))).toBe("020100")
    expect(hex(integer(127))).toBe("02017f")
    expect(hex(integer(128))).toBe("02020080")
    expect(hex(integer(Uint8Array.of(0, 0, 0x7f)))).toBe("02017f")
  })

  test("object identifiers use base-128 arcs", () => {
    expect(hex(oid("1.2.840.113549"))).toBe("06062a864886f70d")
    expect(hex(oid("2.5.29.17"))).toBe("0603551d11")
  })

  test("long lengths use the multi-byte form", () => {
    expect(hex(octets(new Uint8Array(200))).slice(0, 6)).toBe("0481c8")
    expect(hex(octets(new Uint8Array(300))).slice(0, 8)).toBe("0482012c")
  })
})

describe("jws", () => {
  test("RFC 7638 §3.1 thumbprint, ignoring non-required members", () => {
    const jwk: Jwk = {
      kty: "RSA",
      n: "0vx7agoebGcQSuuPiLJXZptN9nndrQmbXEps2aiAFbWhM78LhWx4cbbfAAtVT86zwu1RK7aPFFxuhDR1L6tSoc_BJECPebWKRXjBZCiFV4n3oknjhMstn64tZ_2W-5JsGY4Hc5n9yBXArwl93lqt7_RN5w6Cf0h4QyQ5v-65YGjQR0_FDW2QvzqY368QQMicAtaSqzs8KJZgnYb9c7d0zgdAZHzu6qMQvRL5hajrn1n91CbOpbISD08qNLyrdkt-bFTWhAI4vMQFh6WeZu0fM4lFd2NcRwr3XPksINHaQ-G_xBniIqbw0Ls1jF44-csFCur-kEgU8awapJzKnqDKgw",
      e: "AQAB",
      alg: "RS256",
      kid: "2011-04-29",
    }
    expect(thumbprint(jwk)).toBe("NzbLsXh8uDCcd-6MNwXF4W_7noWXFZAfHkxZsRGC9Xs")
  })

  test("the public JWK never carries the private scalar", () => {
    const jwk = publicJwk(generateKey())
    expect(Object.keys(jwk).sort()).toEqual(["crv", "kty", "x", "y"])
  })

  test("ES256 signature verifies with node:crypto against the embedded jwk", () => {
    const key = generateKey()
    const jws = signJws({ key, url: "https://ca.test/new-acct", nonce: "n1", payload: { a: 1 } })
    const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString())
    expect(header).toMatchObject({ alg: "ES256", nonce: "n1", url: "https://ca.test/new-acct" })
    expect(header.kid).toBeUndefined()
    const pub = createPublicKey({ key: header.jwk, format: "jwk" })
    const ok = verify(
      "sha256",
      Buffer.from(`${jws.protected}.${jws.payload}`),
      { key: pub, dsaEncoding: "ieee-p1363" },
      Buffer.from(jws.signature, "base64url"),
    )
    expect(ok).toBe(true)
    expect(Buffer.from(jws.signature, "base64url").length).toBe(64)
  })

  test("kid replaces jwk, and POST-as-GET has an empty payload", () => {
    const jws = signJws({
      key: generateKey(),
      url: "https://ca.test/order/1",
      nonce: "n2",
      payload: null,
      kid: "https://ca.test/acct/1",
    })
    const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString())
    expect(header.kid).toBe("https://ca.test/acct/1")
    expect(header.jwk).toBeUndefined()
    expect(jws.payload).toBe("")
  })
})

describe("csr", () => {
  const openssl = Bun.which("openssl")

  test.skipIf(!openssl)("openssl verifies the self-signature and reads every SAN", async () => {
    const csr = pem(
      "CERTIFICATE REQUEST",
      buildCsr(["mail.example.com", "imap.example.com"], generateKey()),
    )
    const proc = Bun.spawn([openssl as string, "req", "-in", "-", "-verify", "-noout", "-text"], {
      stdin: new TextEncoder().encode(csr),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code).toBe(0)
    expect(`${out}${err}`).toContain("verify OK")
    expect(out).toContain("CN=mail.example.com")
    expect(out).toContain("DNS:mail.example.com, DNS:imap.example.com")
  })

  test.skipIf(!openssl)("a name too long for CN is left out of the subject", async () => {
    const long = `${"a".repeat(60)}.example.com`
    const csr = pem("CERTIFICATE REQUEST", buildCsr([long], generateKey()))
    const proc = Bun.spawn([openssl as string, "req", "-in", "-", "-verify", "-noout", "-text"], {
      stdin: new TextEncoder().encode(csr),
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = await new Response(proc.stdout).text()
    expect(await proc.exited).toBe(0)
    expect(out).not.toContain("CN=")
    expect(out).toContain(`DNS:${long}`)
  })
})

describe("renewal policy", () => {
  const stored = (days: number, names = ["mail.example.test"]): StoredCertificate => ({
    chain: "",
    key: "",
    notAfter: new Date(Date.now() + days * DAY + 60_000),
    names,
  })

  test("renews at 30 days left, not before", () => {
    expect(renewalReason(stored(31), ["mail.example.test"])).toBeNull()
    expect(renewalReason(stored(30), ["mail.example.test"])).toBeNull()
    expect(renewalReason(stored(29), ["mail.example.test"])).toContain("expires in 29 days")
    expect(renewalReason(stored(-1), ["mail.example.test"])).toContain("expires in 0 days")
  })

  test("renews when there is nothing, or a configured name is missing", () => {
    expect(renewalReason(null, ["mail.example.test"])).toBe("no certificate yet")
    expect(renewalReason(stored(80), ["mail.example.test", "imap.example.test"])).toContain(
      "imap.example.test",
    )
  })

  test("backoff doubles from an hour and stops at a day", () => {
    expect(backoffMs(1)).toBe(3_600_000)
    expect(backoffMs(2)).toBe(7_200_000)
    expect(backoffMs(10)).toBe(DAY)
  })

  test("Retry-After in seconds or a date, floored and capped", () => {
    expect(retryAfterMs(null, 500)).toBe(500)
    expect(retryAfterMs("2", 500)).toBe(2000)
    expect(retryAfterMs("0", 500)).toBe(500)
    expect(retryAfterMs("3600", 500)).toBe(60_000)
    expect(retryAfterMs(new Date(Date.now() + 5000).toUTCString(), 500)).toBeGreaterThan(3000)
  })

  test("refuses to run without an explicit address and agreement", () => {
    const base: AcmeSettings = {
      directory: "https://ca.test/dir",
      email: "ops@example.com",
      agreeTos: true,
      domains: ["mail.example.com"],
      dir: "/tmp/x",
    }
    expect(settingsProblems(base)).toEqual([])
    expect(settingsProblems({ ...base, email: "" }).join()).toContain("ACME_EMAIL")
    expect(settingsProblems({ ...base, agreeTos: false }).join()).toContain("ACME_AGREE_TOS")
    expect(settingsProblems({ ...base, domains: ["*.example.com"] }).join()).toContain("wildcard")
    expect(settingsProblems({ ...base, domains: ["localhost"] }).join()).toContain(
      "public hostname",
    )
  })
})

// --- A fake ACME CA: just enough of RFC 8555 to drive the real client. ---

type Node = { start: number; body: number; end: number }

const readNode = (buf: Uint8Array, at: number): Node => {
  let len = buf[at + 1] as number
  let header = 2
  if (len & 0x80) {
    const n = len & 0x7f
    len = 0
    for (let i = 0; i < n; i++) len = len * 256 + (buf[at + 2 + i] as number)
    header += n
  }
  return { start: at, body: at + header, end: at + header + len }
}

const childNodes = (buf: Uint8Array, node: Node): Node[] => {
  const out: Node[] = []
  for (let p = node.body; p < node.end; ) {
    const c = readNode(buf, p)
    out.push(c)
    p = c.end
  }
  return out
}

const spkiFromCsr = (csr: Uint8Array): Uint8Array => {
  const info = childNodes(csr, readNode(csr, 0))[0] as Node
  const spki = childNodes(csr, info)[2] as Node
  return csr.slice(spki.start, spki.end)
}

const utcTime = (d: Date) =>
  tlv(0x17, new TextEncoder().encode(`${d.toISOString().slice(2, 19).replace(/[-T:]/g, "")}Z`))

const makeCert = (input: {
  serial: number
  subject: string
  issuer: string
  spki: Uint8Array
  signer: KeyObject
  notAfter: Date
  names?: string[]
}): string => {
  const name = (cn: string) => sequence(set(sequence(oid("2.5.4.3"), utf8(cn))))
  const alg = sequence(oid("1.2.840.10045.4.3.2"))
  const ext = input.names
    ? [
        context(
          3,
          true,
          sequence(
            sequence(
              oid("2.5.29.17"),
              octets(
                sequence(...input.names.map((n) => context(2, false, new TextEncoder().encode(n)))),
              ),
            ),
          ),
        ),
      ]
    : []
  const tbs = sequence(
    context(0, true, integer(2)),
    integer(input.serial),
    alg,
    name(input.issuer),
    sequence(utcTime(new Date(Date.now() - 60_000)), utcTime(input.notAfter)),
    name(input.subject),
    input.spki,
    ...ext,
  )
  return pem(
    "CERTIFICATE",
    sequence(tbs, alg, bits(new Uint8Array(sign("sha256", tbs, input.signer)))),
  )
}

type FakeCa = {
  url: string
  stop: () => void
  validDays: number
  failValidation: boolean
  badNonceOnce: boolean
  accounts: number
  issued: number
}

const startFakeCa = (responderPort: () => number): FakeCa => {
  const caKey = generateKey()
  const caSpki = new Uint8Array(createPublicKey(caKey).export({ type: "spki", format: "der" }))
  const caCert = makeCert({
    serial: 1,
    subject: "Fake CA",
    issuer: "Fake CA",
    spki: caSpki,
    signer: caKey,
    notAfter: new Date(Date.now() + 365 * DAY),
  })

  const nonces = new Set<string>()
  const accounts = new Map<string, { url: string; key: KeyObject }>()
  const orders = new Map<
    string,
    { status: string; authz: string[]; names: string[]; cert?: string; polls: number }
  >()
  const authzs = new Map<string, { status: string; name: string; token: string; thumb: string }>()
  let seq = 0

  const state: FakeCa = {
    url: "",
    stop: () => {},
    validDays: 90,
    failValidation: false,
    badNonceOnce: false,
    accounts: 0,
    issued: 0,
  }

  const nonce = () => {
    const n = `nonce-${++seq}`
    nonces.add(n)
    return n
  }

  const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: {
        "replay-nonce": nonce(),
        "content-type":
          typeof body === "string" ? "application/pem-certificate-chain" : "application/json",
        ...headers,
      },
    })

  const problem = (status: number, type: string, detail: string) =>
    reply(status, { type: `urn:ietf:params:acme:error:${type}`, detail })

  let port = 0
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req): Promise<Response> => {
      const url = new URL(req.url)
      const base = `http://127.0.0.1:${port}`
      if (url.pathname === "/dir") {
        return Response.json({
          newNonce: `${base}/nonce`,
          newAccount: `${base}/acct`,
          newOrder: `${base}/order`,
          meta: { termsOfService: `${base}/tos` },
        })
      }
      if (url.pathname === "/nonce")
        return new Response(null, { headers: { "replay-nonce": nonce() } })
      if (req.method !== "POST") return new Response("no", { status: 405 })

      const jws = (await req.json()) as { protected: string; payload: string; signature: string }
      const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString())
      if (header.url !== req.url) return problem(401, "unauthorized", "url mismatch")
      if (!nonces.delete(header.nonce)) return problem(400, "badNonce", "unknown nonce")
      if (state.badNonceOnce && url.pathname === "/order") {
        state.badNonceOnce = false
        return problem(400, "badNonce", "forced")
      }

      let key: KeyObject
      if (url.pathname === "/acct") {
        if (!header.jwk || header.kid) return problem(400, "malformed", "newAccount needs jwk")
        key = createPublicKey({ key: header.jwk, format: "jwk" })
      } else {
        const account = [...accounts.values()].find((a) => a.url === header.kid)
        if (!account || header.jwk) return problem(401, "unauthorized", "unknown kid")
        key = account.key
      }
      const valid = verify(
        "sha256",
        Buffer.from(`${jws.protected}.${jws.payload}`),
        { key, dsaEncoding: "ieee-p1363" },
        Buffer.from(jws.signature, "base64url"),
      )
      if (!valid) return problem(400, "malformed", "bad signature")
      const payload =
        jws.payload === "" ? null : JSON.parse(Buffer.from(jws.payload, "base64url").toString())

      if (url.pathname === "/acct") {
        if (payload?.termsOfServiceAgreed !== true) return problem(400, "malformed", "tos")
        const thumb = thumbprint(header.jwk)
        let account = accounts.get(thumb)
        if (!account) {
          account = { url: `${base}/acct/${accounts.size + 1}`, key }
          accounts.set(thumb, account)
          state.accounts += 1
        }
        return reply(201, { status: "valid", contact: payload.contact }, { location: account.url })
      }

      const thumb = thumbprint(publicJwkFromKey(key))

      if (url.pathname === "/order") {
        const id = `${++seq}`
        const names = (payload.identifiers as { value: string }[]).map((i) => i.value)
        const authz = names.map((name) => {
          const aid = `${++seq}`
          authzs.set(aid, {
            status: "pending",
            name,
            token: `tok${aid}_${createHash("sha256").update(aid).digest("hex").slice(0, 16)}`,
            thumb,
          })
          return `${base}/authz/${aid}`
        })
        orders.set(id, { status: "pending", authz, names, polls: 0 })
        return reply(
          201,
          { status: "pending", authorizations: authz, finalize: `${base}/finalize/${id}` },
          { location: `${base}/orders/${id}` },
        )
      }

      const [, kind, id = ""] = url.pathname.split("/")
      if (kind === "authz") {
        const a = authzs.get(id)
        if (!a) return problem(404, "malformed", "no authz")
        return reply(200, {
          status: a.status,
          identifier: { type: "dns", value: a.name },
          challenges: [
            {
              type: "tls-alpn-01",
              url: `${base}/chall-alpn/${id}`,
              token: a.token,
              status: "pending",
            },
            {
              type: "http-01",
              url: `${base}/chall/${id}`,
              token: a.token,
              status: a.status === "invalid" ? "invalid" : a.status,
              ...(a.status === "invalid"
                ? {
                    error: {
                      type: "urn:ietf:params:acme:error:unauthorized",
                      detail: "wrong key authorization",
                    },
                  }
                : {}),
            },
          ],
        })
      }
      if (kind === "chall") {
        const a = authzs.get(id)
        if (!a) return problem(404, "malformed", "no challenge")
        // Validate the way a CA does: fetch the token over plain HTTP, later.
        setTimeout(async () => {
          const res = await fetch(
            `http://127.0.0.1:${responderPort()}/.well-known/acme-challenge/${a.token}`,
          )
          const body = await res.text()
          a.status =
            !state.failValidation && res.ok && body === `${a.token}.${a.thumb}`
              ? "valid"
              : "invalid"
        }, 20)
        return reply(200, { type: "http-01", url: req.url, token: a.token, status: "processing" })
      }
      if (kind === "orders" || kind === "finalize") {
        const o = orders.get(id)
        if (!o) return problem(404, "malformed", "no order")
        if (
          o.status === "pending" &&
          o.authz.every((u) => authzs.get(u.split("/").pop() as string)?.status === "valid")
        )
          o.status = "ready"
        if (
          o.status === "pending" &&
          o.authz.some((u) => authzs.get(u.split("/").pop() as string)?.status === "invalid")
        )
          o.status = "invalid"
        if (kind === "finalize") {
          if (o.status !== "ready") return problem(403, "orderNotReady", o.status)
          const csr = new Uint8Array(Buffer.from(payload.csr, "base64url"))
          state.issued += 1
          const leaf = makeCert({
            serial: 1000 + state.issued,
            subject: o.names[0] as string,
            issuer: "Fake CA",
            spki: spkiFromCsr(csr),
            signer: caKey,
            notAfter: new Date(Date.now() + state.validDays * DAY),
            names: o.names,
          })
          o.cert = `${leaf}${caCert}`
          o.status = "processing"
        } else if (o.status === "processing" && ++o.polls > 1) {
          o.status = "valid"
        }
        return reply(
          200,
          {
            status: o.status,
            authorizations: o.authz,
            finalize: `${base}/finalize/${id}`,
            ...(o.status === "valid" ? { certificate: `${base}/cert/${id}` } : {}),
          },
          { "retry-after": "0" },
        )
      }
      if (kind === "cert") {
        const o = orders.get(id)
        if (!o?.cert) return problem(404, "malformed", "no cert")
        return reply(200, o.cert)
      }
      return problem(404, "malformed", "unknown")
    },
  })
  port = server.port as number
  state.url = `http://127.0.0.1:${port}/dir`
  state.stop = () => server.stop(true)
  return state
}

const publicJwkFromKey = (key: KeyObject): Jwk => publicJwk(key)

describe("challenge responder", () => {
  test("only in-flight tokens are served, through the normal fetch path", async () => {
    const fetchApp = buildFetch(null)
    addChallenge("live-token", "live-token.thumb")
    try {
      const hit = await fetchApp(
        new Request("http://localhost:3000/.well-known/acme-challenge/live-token"),
      )
      expect(hit.status).toBe(200)
      expect(await hit.text()).toBe("live-token.thumb")
      const miss = await fetchApp(
        new Request("http://localhost:3000/.well-known/acme-challenge/other"),
      )
      expect(miss.status).toBe(404)
    } finally {
      removeChallenge("live-token")
    }
    const gone = await fetchApp(
      new Request("http://localhost:3000/.well-known/acme-challenge/live-token"),
    )
    expect(gone.status).toBe(404)
  })

  test("the port-80 listener redirects everything else to https", async () => {
    const listener = startChallengeListener(0, "127.0.0.1")
    try {
      const res = await fetch(`http://127.0.0.1:${listener.port}/app?x=1`, { redirect: "manual" })
      expect(res.status).toBe(301)
      expect(res.headers.get("location")).toBe("https://127.0.0.1/app?x=1")
    } finally {
      listener.stop(true)
    }
  })
})

describe("issuance against a fake CA", () => {
  let ca: FakeCa
  let responder: ReturnType<typeof startChallengeListener>
  let dir: string
  let settings: AcmeSettings
  let tlsPort = 0
  let stopTls: () => void = () => {}
  const tuning = () => ({ pollMs: 10, timeoutMs: 10_000 })

  const peerSerial = () =>
    new Promise<string>((resolve, reject) => {
      void Bun.connect({
        hostname: "127.0.0.1",
        port: tlsPort,
        tls: { rejectUnauthorized: false },
        socket: {
          handshake(s) {
            resolve(String(s.getPeerCertificate()?.serialNumber ?? "").toUpperCase())
            s.end()
          },
          data() {},
          open() {},
          close() {},
          error(_s, e) {
            reject(e)
          },
          connectError(_s, e) {
            reject(e)
          },
        },
      }).catch(reject)
    })

  const leafSerial = (stored: { chain: string }) =>
    new X509Certificate(stored.chain).serialNumber.toUpperCase()

  beforeAll(async () => {
    responder = startChallengeListener(0, "127.0.0.1")
    ca = startFakeCa(() => responder.port as number)
    dir = await mkdtemp(join(tmpdir(), "corsair-acme-"))
    settings = {
      directory: ca.url,
      email: "ops@example.test",
      agreeTos: true,
      domains: ["mail.example.test", "imap.example.test"],
      dir,
    }
    // A fixed port, so the implicit-TLS listener can be rebound on renewal.
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
    tlsPort = probe.port
    probe.stop(true)
    stopTls = serveImplicitTls("acmetest", (tls) =>
      Bun.listen({
        hostname: "127.0.0.1",
        port: tlsPort,
        tls,
        socket: { data() {}, open() {}, close() {}, error() {} },
      }),
    )
  })

  afterAll(async () => {
    stopTls()
    responder.stop(true)
    ca.stop()
    await rm(dir, { recursive: true, force: true })
  })

  test("a first certificate is issued, stored 0600, and opens the TLS listener", async () => {
    ca.badNonceOnce = true
    const result = await checkCertificate(settings, tuning())
    expect(result.renewed).toBe(true)
    expect(ca.badNonceOnce).toBe(false) // the rejected request was retried
    const stored = result.stored as StoredCertificate
    expect(stored.names).toEqual(["mail.example.test", "imap.example.test"])
    expect(stored.chain.match(/BEGIN CERTIFICATE/g)?.length).toBe(2)

    const stat = await Bun.file(certificateFile(dir)).stat()
    expect(stat.mode & 0o777).toBe(0o600)
    const account = await Bun.file(join(dir, "account.key")).stat()
    expect(account.mode & 0o777).toBe(0o600)

    expect(currentTls()?.cert).toBe(stored.chain)
    expect(await peerSerial()).toBe(leafSerial(stored))
  })

  test("a valid certificate is left alone", async () => {
    const before = ca.issued
    const result = await checkCertificate(settings, tuning())
    expect(result.renewed).toBe(false)
    expect(ca.issued).toBe(before)
  })

  test("renewal inside 30 days reuses the account and hot-swaps the listener", async () => {
    const withPop = { ...settings, domains: [...settings.domains, "pop.example.test"] }
    ca.validDays = 10
    const short = (await checkCertificate(withPop, tuning())).stored as StoredCertificate
    ca.validDays = 90
    const accounts = ca.accounts

    const result = await checkCertificate(withPop, tuning())
    expect(result.renewed).toBe(true)
    expect(result.reason).toContain("expires in")
    expect(ca.accounts).toBe(accounts)
    const renewed = result.stored as StoredCertificate
    expect(leafSerial(renewed)).not.toBe(leafSerial(short))
    expect(await peerSerial()).toBe(leafSerial(renewed))
  })

  test("a failed renewal keeps the working certificate on disk and in service", async () => {
    ca.validDays = 10
    const short = (
      await checkCertificate(
        { ...settings, domains: [...settings.domains, "smtp.example.test"] },
        tuning(),
      )
    ).stored as StoredCertificate
    ca.validDays = 90
    const onDisk = await readFile(certificateFile(dir), "latin1")

    ca.failValidation = true
    try {
      await expect(
        checkCertificate(
          { ...settings, domains: [...settings.domains, "smtp.example.test"] },
          tuning(),
        ),
      ).rejects.toThrow(/Validation of .* failed/)
    } finally {
      ca.failValidation = false
    }

    expect(await readFile(certificateFile(dir), "latin1")).toBe(onDisk)
    expect(currentTls()?.cert).toBe(short.chain)
    expect(await peerSerial()).toBe(leafSerial(short))
  })
})
