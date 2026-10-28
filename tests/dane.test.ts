import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createHash, X509Certificate } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import {
  type DanePolicy,
  matchChain,
  parseResolver,
  policyForHost,
  probeDane,
  secureMx,
  setDane,
  usableTlsa,
} from "../src/dane/index.ts"
import { decodeMessage, encodeMessage, encodeQuery, type Tlsa, TYPE } from "../src/dnswire/index.ts"
import { deliverToMx } from "../src/smtp/client/index.ts"

// --- certificates ----------------------------------------------------------

let dir = ""
const pem = (name: string) => Bun.file(`${dir}/${name}`).text()
let leaf: X509Certificate
let ca: X509Certificate
let other: X509Certificate

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest()
const sha512 = (b: Buffer) => createHash("sha512").update(b).digest()
const spki = (c: X509Certificate) => c.publicKey.export({ type: "spki", format: "der" }) as Buffer
const tlsa = (usage: number, selector: number, matchingType: number, data: Buffer): Tlsa => ({
  usage,
  selector,
  matchingType,
  data: new Uint8Array(data),
})

beforeAll(async () => {
  dir = await mkdtemp("/tmp/corsairdane")
  // A shell of its own: `Bun.$.cwd()` changes the default for every later test file.
  const sh = new Bun.$.Shell().cwd(dir)
  await sh`openssl req -x509 -newkey rsa:2048 -nodes -days 2 -keyout ca.key -out ca.pem -subj /CN=Dane-Test-CA -addext basicConstraints=critical,CA:TRUE -addext keyUsage=keyCertSign`.quiet()
  await sh`openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj /CN=mx.example.test`.quiet()
  await Bun.write(`${dir}/ext`, "subjectAltName=DNS:localhost,DNS:mx.example.test\n")
  await sh`openssl x509 -req -in leaf.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 1 -out leaf.pem -extfile ext`.quiet()
  await sh`openssl req -x509 -newkey rsa:2048 -nodes -days 1 -keyout other.key -out other.pem -subj /CN=other.invalid`.quiet()
  await Bun.write(`${dir}/chain.pem`, (await pem("leaf.pem")) + (await pem("ca.pem")))
  leaf = new X509Certificate(await pem("leaf.pem"))
  ca = new X509Certificate(await pem("ca.pem"))
  other = new X509Certificate(await pem("other.pem"))
}, 30000)

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

afterEach(() => setDane(null))

// --- wire format -----------------------------------------------------------

describe("dns wire format", () => {
  test("a query sets RD and AD in the header and DO in EDNS", () => {
    const q = encodeQuery({ id: 0x1234, name: "_25._tcp.mx.example.", type: TYPE.TLSA })
    const dv = new DataView(q.buffer)
    expect(dv.getUint16(0)).toBe(0x1234)
    expect(dv.getUint16(2)).toBe(0x0120)
    expect(dv.getUint16(4)).toBe(1) // QDCOUNT
    expect(dv.getUint16(10)).toBe(1) // ARCOUNT: the OPT record
    // Question: 3 _25 4 _tcp 2 mx 7 example 0, TLSA, IN
    const name = [3, 95, 50, 53, 4, 95, 116, 99, 112, 2, 109, 120, 7, ...Buffer.from("example"), 0]
    expect(Array.from(q.subarray(12, 12 + name.length))).toEqual(name)
    const opt = q.subarray(12 + name.length + 4)
    // root, TYPE 41, size 1232, ext-rcode 0, version 0, flags 0x8000 (DO), rdlen 0
    expect(Array.from(opt)).toEqual([0, 0, 41, 0x04, 0xd0, 0, 0, 0x80, 0, 0, 0])
  })

  test("a hand-built reply with compression decodes TLSA, MX and the AD bit", () => {
    // Built byte by byte from RFC 1035 §4 and RFC 6698 §2.1, not with the
    // encoder, so a symmetric bug in both halves cannot pass.
    const digest = Buffer.alloc(32, 0xab)
    const bytes = Buffer.from([
      0xbe,
      0xef, // id
      0x81,
      0xa0, // QR RD RA AD, NOERROR
      0,
      1,
      0,
      3,
      0,
      0,
      0,
      0,
      // question at offset 12: _25._tcp.mx.example.test TLSA IN
      3,
      95,
      50,
      53,
      4,
      95,
      116,
      99,
      112,
      2,
      109,
      120, // "mx" at offset 21
      7,
      ...Buffer.from("example"),
      4,
      ...Buffer.from("test"),
      0,
      0,
      52,
      0,
      1,
      // answer 1: pointer to the question name, TLSA, IN, TTL 300, rdlen 35
      0xc0,
      12,
      0,
      52,
      0,
      1,
      0,
      0,
      1,
      44,
      0,
      35,
      3,
      1,
      1,
      ...digest,
      // answer 2: TLSA with a PKIX-EE usage and a short body
      0xc0,
      12,
      0,
      52,
      0,
      1,
      0,
      0,
      1,
      44,
      0,
      4,
      1,
      0,
      0,
      0xff,
      // answer 3: "example.test" (pointer to offset 24) MX 10, exchange "mx" + pointer to 24
      0xc0,
      24,
      0,
      15,
      0,
      1,
      0,
      0,
      0,
      60,
      0,
      7,
      0,
      10,
      2,
      109,
      120,
      0xc0,
      24,
    ])
    const m = decodeMessage(new Uint8Array(bytes))
    expect(m.id).toBe(0xbeef)
    expect(m.flags.ad).toBe(true)
    expect(m.flags.qr).toBe(true)
    expect(m.rcode).toBe(0)
    expect(m.questions[0]).toEqual({ name: "_25._tcp.mx.example.test", type: 52, class: 1 })
    expect(m.answers[0]?.name).toBe("_25._tcp.mx.example.test")
    expect(m.answers[0]?.tlsa?.usage).toBe(3)
    expect(m.answers[0]?.tlsa?.selector).toBe(1)
    expect(m.answers[0]?.tlsa?.matchingType).toBe(1)
    expect(Buffer.from(m.answers[0]?.tlsa?.data ?? []).equals(digest)).toBe(true)
    expect(m.answers[1]?.tlsa?.usage).toBe(1)
    expect(m.answers[2]?.name).toBe("example.test")
    expect(m.answers[2]?.mx).toEqual({ preference: 10, exchange: "mx.example.test" })
  })

  test("AD clear, truncation, and NXDOMAIN are read from the header", () => {
    const m = decodeMessage(new Uint8Array([0, 1, 0x82, 0x83, 0, 0, 0, 0, 0, 0, 0, 0]))
    expect(m.flags.ad).toBe(false)
    expect(m.flags.tc).toBe(true)
    expect(m.rcode).toBe(3)
  })

  test("a compression loop and a truncated record are rejected", () => {
    const loop = new Uint8Array([0, 1, 0x81, 0x80, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 1, 0, 1])
    expect(() => decodeMessage(loop)).toThrow()
    const short = new Uint8Array([
      0, 1, 0x81, 0x80, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 52, 0, 1, 0, 0, 0, 1, 0, 9, 3,
    ])
    expect(() => decodeMessage(short)).toThrow()
  })

  test("the encoder and decoder agree", () => {
    const rdata = new Uint8Array([3, 1, 1, ...Buffer.alloc(32, 7)])
    const bytes = encodeMessage({
      id: 9,
      flags: { qr: true, ad: true },
      questions: [{ name: "_25._tcp.a.test", type: TYPE.TLSA }],
      answers: [{ name: "_25._tcp.a.test", type: TYPE.TLSA, rdata }],
    })
    const m = decodeMessage(bytes)
    expect(m.flags.ad).toBe(true)
    expect(m.answers[0]?.tlsa?.data.length).toBe(32)
  })

  test("resolver specs", () => {
    expect(parseResolver("127.0.0.1")).toEqual({ host: "127.0.0.1", port: 53 })
    expect(parseResolver("127.0.0.1:5353")).toEqual({ host: "127.0.0.1", port: 5353 })
    expect(parseResolver("[::1]:5353")).toEqual({ host: "::1", port: 5353 })
    expect(parseResolver("::1")).toEqual({ host: "::1", port: 53 })
    expect(parseResolver("resolver.example")).toBeNull()
  })
})

// --- matching --------------------------------------------------------------

describe("TLSA matching", () => {
  const policy = (records: Tlsa[], names = ["mx.example.test"]): DanePolicy => ({
    records,
    names,
    serverName: names[0] as string,
  })

  test("PKIX usages, unknown selectors, and wrong-length digests are unusable", () => {
    const d = Buffer.alloc(32, 1)
    expect(usableTlsa([tlsa(0, 1, 1, d), tlsa(1, 1, 1, d)])).toEqual([])
    expect(usableTlsa([tlsa(3, 2, 1, d), tlsa(3, 1, 3, d), tlsa(3, 1, 2, d)])).toEqual([])
    expect(usableTlsa([tlsa(3, 1, 1, d), tlsa(2, 0, 1, d)]).length).toBe(2)
  })

  test("3 1 1 matches the leaf's SPKI by SHA-256", () => {
    expect(matchChain([leaf], policy([tlsa(3, 1, 1, sha256(spki(leaf)))])).ok).toBe(true)
    expect(matchChain([other], policy([tlsa(3, 1, 1, sha256(spki(leaf)))])).ok).toBe(false)
  })

  test("3 0 1 matches the whole leaf certificate", () => {
    expect(matchChain([leaf], policy([tlsa(3, 0, 1, sha256(leaf.raw))])).ok).toBe(true)
    // The SPKI digest under selector 0 is a different object and must not match.
    expect(matchChain([leaf], policy([tlsa(3, 0, 1, sha256(spki(leaf)))])).ok).toBe(false)
  })

  test("3 1 2 matches by SHA-512", () => {
    expect(matchChain([leaf], policy([tlsa(3, 1, 2, sha512(spki(leaf)))])).ok).toBe(true)
  })

  test("DANE-EE ignores the name and the expiry", () => {
    const later = new Date(Date.now() + 365 * 86400_000)
    const result = matchChain(
      [other],
      policy([tlsa(3, 1, 1, sha256(spki(other)))], ["nowhere.test"]),
      later,
    )
    expect(result.ok).toBe(true)
  })

  test("2 0 1 matches the issuer and checks the chain and the name", () => {
    const record = tlsa(2, 0, 1, sha256(ca.raw))
    expect(matchChain([leaf, ca], policy([record])).ok).toBe(true)

    const wrongName = matchChain([leaf, ca], policy([record], ["mail.other.test"]))
    expect(wrongName).toMatchObject({ ok: false, outcome: "certificate-host-mismatch" })

    const expired = matchChain([leaf, ca], policy([record]), new Date(Date.now() + 30 * 86400_000))
    expect(expired).toMatchObject({ ok: false, outcome: "certificate-expired" })

    // The anchor must have issued the leaf, not merely be present.
    const forged = matchChain([other, ca], policy([record], ["other.invalid"]))
    expect(forged).toMatchObject({ ok: false, outcome: "certificate-not-trusted" })

    // A TA record never matches the leaf itself.
    expect(matchChain([leaf], policy([tlsa(2, 0, 1, sha256(leaf.raw))])).ok).toBe(false)
  })

  test("2 1 0 can anchor a chain whose root was not sent", () => {
    expect(matchChain([leaf], policy([tlsa(2, 1, 0, spki(ca))])).ok).toBe(true)
    expect(matchChain([other], policy([tlsa(2, 1, 0, spki(ca))], ["other.invalid"])).ok).toBe(false)
  })

  test("no certificate is a failure", () => {
    expect(matchChain([], policy([tlsa(3, 1, 1, sha256(spki(leaf)))]))).toMatchObject({ ok: false })
  })
})

// --- stub resolver ---------------------------------------------------------

type Entry = {
  rcode?: number
  ad?: boolean
  answers?: { name: string; type: number; rdata: Uint8Array }[]
}

const nameBytes = (name: string): number[] => [
  ...name.split(".").flatMap((l) => [l.length, ...Buffer.from(l)]),
  0,
]
const rd = {
  a: (ip: string) => new Uint8Array(ip.split(".").map(Number)),
  mx: (pref: number, host: string) => new Uint8Array([pref >> 8, pref & 0xff, ...nameBytes(host)]),
  cname: (host: string) => new Uint8Array(nameBytes(host)),
  tlsa: (r: Tlsa) => new Uint8Array([r.usage, r.selector, r.matchingType, ...r.data]),
}

/**
 * A resolver that answers from a table, over UDP and TCP on one port. Names in
 * `truncate` answer UDP with TC set so the client must come back over TCP.
 */
const stubResolver = async (table: Map<string, Entry>, truncate: Set<string> = new Set()) => {
  const asked: string[] = []
  const reply = (packet: Uint8Array, tcp: boolean): Uint8Array => {
    const q = decodeMessage(packet)
    const question = q.questions[0] as { name: string; type: number }
    const key = `${question.name.toLowerCase()}|${question.type}`
    asked.push(`${tcp ? "tcp" : "udp"}:${key}`)
    const entry = table.get(key) ?? { rcode: 3, ad: true }
    const tc = !tcp && truncate.has(key)
    return encodeMessage({
      id: q.id,
      flags: { qr: true, rd: true, ra: true, ad: entry.ad ?? false, tc },
      rcode: entry.rcode ?? 0,
      questions: [question],
      answers: tc ? [] : (entry.answers ?? []),
    })
  }
  const udp = await Bun.udpSocket({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket, data, port, address) {
        socket.send(reply(new Uint8Array(data), false), port, address)
      },
    },
  })
  const tcp = Bun.listen({
    hostname: "127.0.0.1",
    port: udp.port,
    socket: {
      data(socket, data) {
        const body = new Uint8Array(data).subarray(2)
        const out = reply(body, true)
        socket.write(new Uint8Array([out.length >> 8, out.length & 0xff, ...out]))
      },
    },
  })
  return {
    port: udp.port,
    asked,
    stop: () => {
      udp.close()
      tcp.stop(true)
    },
  }
}

const enable = (port: number) =>
  setDane({ enabled: true, resolver: { host: "127.0.0.1", port }, reason: "test" })

describe("resolver probe", () => {
  test("a resolver that authenticates the root and refuses a bogus name is trusted", async () => {
    const stub = await stubResolver(
      new Map<string, Entry>([
        ["|6", { ad: true, answers: [{ name: ".", type: 6, rdata: new Uint8Array(22) }] }],
        ["dnssec-failed.org|1", { rcode: 2 }],
      ]),
    )
    try {
      const state = await probeDane({
        mode: "auto",
        resolver: `127.0.0.1:${stub.port}`,
        log: false,
      })
      expect(state.enabled).toBe(true)
    } finally {
      stub.stop()
    }
  })

  test("no AD on the root, or an answer for the bogus name, keeps DANE off", async () => {
    const plain = await stubResolver(new Map<string, Entry>([["|6", { ad: false, answers: [] }]]))
    const blind = await stubResolver(
      new Map<string, Entry>([
        ["|6", { ad: true, answers: [] }],
        [
          "dnssec-failed.org|1",
          { ad: true, answers: [{ name: "dnssec-failed.org", type: 1, rdata: rd.a("192.0.2.1") }] },
        ],
      ]),
    )
    try {
      expect((await probeDane({ resolver: `127.0.0.1:${plain.port}`, log: false })).enabled).toBe(
        false,
      )
      expect((await probeDane({ resolver: `127.0.0.1:${blind.port}`, log: false })).enabled).toBe(
        false,
      )
    } finally {
      plain.stop()
      blind.stop()
    }
  })

  test("a remote resolver is refused unless trusted, and DANE=off is off", async () => {
    const remote = await probeDane({
      mode: "on",
      resolver: "192.0.2.53",
      trustRemote: false,
      log: false,
    })
    expect(remote.enabled).toBe(false)
    expect(remote.reason).toContain("loopback")
    expect((await probeDane({ mode: "off", log: false })).enabled).toBe(false)
  })
})

describe("DNSSEC lookups and host policy", () => {
  const digest = () => tlsa(3, 1, 1, sha256(spki(leaf)))

  test("an insecure MX means no DANE for any host", async () => {
    const stub = await stubResolver(
      new Map<string, Entry>([
        [
          "insecure.test|15",
          {
            ad: false,
            answers: [{ name: "insecure.test", type: 15, rdata: rd.mx(10, "mx.insecure.test") }],
          },
        ],
      ]),
    )
    enable(stub.port)
    try {
      const mx = await secureMx("insecure.test")
      expect(mx).toEqual({ kind: "hosts", hosts: ["mx.insecure.test"], secure: false })
      const policy = await policyForHost("mx.insecure.test", {
        domain: "insecure.test",
        mxSecure: false,
      })
      expect(policy.kind).toBe("none")
      expect(stub.asked.some((q) => q.includes("_25._tcp"))).toBe(false)
    } finally {
      stub.stop()
    }
  })

  test("insecure address records mean no DANE for that host", async () => {
    const stub = await stubResolver(
      new Map<string, Entry>([
        [
          "mx.a.test|1",
          { ad: false, answers: [{ name: "mx.a.test", type: 1, rdata: rd.a("192.0.2.1") }] },
        ],
        [
          "_25._tcp.mx.a.test|52",
          {
            ad: true,
            answers: [{ name: "_25._tcp.mx.a.test", type: 52, rdata: rd.tlsa(digest()) }],
          },
        ],
      ]),
    )
    enable(stub.port)
    try {
      expect((await policyForHost("mx.a.test", { domain: "a.test", mxSecure: true })).kind).toBe(
        "none",
      )
    } finally {
      stub.stop()
    }
  })

  test("secure TLSA is enforced; SERVFAIL defers; insecure TLSA is ignored", async () => {
    const secureA = (host: string): [string, Entry] => [
      `${host}|1`,
      { ad: true, answers: [{ name: host, type: 1, rdata: rd.a("192.0.2.1") }] },
    ]
    const stub = await stubResolver(
      new Map<string, Entry>([
        secureA("mx.good.test"),
        secureA("mx.bogus.test"),
        secureA("mx.unsigned.test"),
        [
          "_25._tcp.mx.good.test|52",
          {
            ad: true,
            answers: [{ name: "_25._tcp.mx.good.test", type: 52, rdata: rd.tlsa(digest()) }],
          },
        ],
        ["_25._tcp.mx.bogus.test|52", { rcode: 2 }],
        [
          "_25._tcp.mx.unsigned.test|52",
          {
            ad: false,
            answers: [{ name: "_25._tcp.mx.unsigned.test", type: 52, rdata: rd.tlsa(digest()) }],
          },
        ],
      ]),
      new Set(["_25._tcp.mx.good.test|52"]),
    )
    enable(stub.port)
    try {
      const good = await policyForHost("mx.good.test", { domain: "good.test", mxSecure: true })
      expect(good.kind).toBe("dane")
      if (good.kind === "dane") {
        expect(good.policy.records.length).toBe(1)
        expect(good.policy.serverName).toBe("mx.good.test")
        expect(good.policy.names).toEqual(["mx.good.test", "good.test"])
      }
      // The truncated UDP answer was asked again over TCP.
      expect(stub.asked).toContain("tcp:_25._tcp.mx.good.test|52")

      expect(
        (await policyForHost("mx.bogus.test", { domain: "bogus.test", mxSecure: true })).kind,
      ).toBe("defer")
      expect(
        (await policyForHost("mx.unsigned.test", { domain: "unsigned.test", mxSecure: true })).kind,
      ).toBe("none")
    } finally {
      stub.stop()
    }
  })

  test("a secure CNAME makes the expanded name the TLSA base domain", async () => {
    const stub = await stubResolver(
      new Map<string, Entry>([
        [
          "mx.alias.test|1",
          {
            ad: true,
            answers: [
              { name: "mx.alias.test", type: 5, rdata: rd.cname("real.host.test") },
              { name: "real.host.test", type: 1, rdata: rd.a("192.0.2.1") },
            ],
          },
        ],
        [
          "_25._tcp.real.host.test|52",
          {
            ad: true,
            answers: [{ name: "_25._tcp.real.host.test", type: 52, rdata: rd.tlsa(digest()) }],
          },
        ],
      ]),
    )
    enable(stub.port)
    try {
      const policy = await policyForHost("mx.alias.test", { domain: "alias.test", mxSecure: true })
      expect(policy.kind).toBe("dane")
      if (policy.kind === "dane") {
        expect(policy.policy.serverName).toBe("real.host.test")
        expect(policy.policy.names).toContain("mx.alias.test")
      }
    } finally {
      stub.stop()
    }
  })
})

// --- delivery over real sockets --------------------------------------------

const startTlsServer = async (cert: string) => {
  const script = new URL("./support/starttlsserver.py", import.meta.url).pathname
  const verdict = `${dir}/verdict${Math.random().toString(36).slice(2)}.json`
  const proc = Bun.spawn(["python3", script, `${dir}/${cert}`, `${dir}/leaf.key`, "0", verdict], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  const port = Number(new TextDecoder().decode(value).match(/READY (\d+)/)?.[1])
  return {
    port,
    proc,
    seen: async () => {
      // It exits on its own once the session ends; a kill mid-flush would
      // leave a half-written verdict.
      await Promise.race([proc.exited, Bun.sleep(3000)])
      proc.kill()
      await proc.exited
      return (await Bun.file(verdict).json()) as { commands: string[]; upgraded: boolean }
    },
  }
}

/** DNS for dane.test → MX localhost, with `tlsaAd` deciding whether the TLSA answer is signed. */
const deliveryDns = (records: Tlsa[], tlsaAd = true) =>
  new Map<string, Entry>([
    [
      "dane.test|15",
      { ad: true, answers: [{ name: "dane.test", type: 15, rdata: rd.mx(10, "localhost") }] },
    ],
    [
      "localhost|1",
      { ad: true, answers: [{ name: "localhost", type: 1, rdata: rd.a("127.0.0.1") }] },
    ],
    [
      "_25._tcp.localhost|52",
      {
        ad: tlsaAd,
        answers: records.map((r) => ({ name: "_25._tcp.localhost", type: 52, rdata: rd.tlsa(r) })),
      },
    ],
  ])

const send = (port: number) =>
  deliverToMx({
    domain: "dane.test",
    mailFrom: "sender@example.invalid",
    rcptTo: "rcpt@dane.test",
    raw: "Subject: dane\r\n\r\nbody\r\n",
    port,
    timeoutMs: 3000,
  })

describe("DANE delivery", () => {
  test("a matching 3 1 1 record delivers over TLS", async () => {
    const stub = await stubResolver(deliveryDns([tlsa(3, 1, 1, sha256(spki(leaf)))]))
    const server = await startTlsServer("leaf.pem")
    enable(stub.port)
    try {
      const result = await send(server.port)
      expect(result.ok).toBe(true)
      expect(result.tls).toMatchObject({ policy: "dane", outcome: "success" })
      expect((await server.seen()).commands).toContain("tls:MAIL")
    } finally {
      server.proc.kill()
      stub.stop()
    }
  }, 15000)

  test("a matching 2 0 1 record delivers, using the chain the server sent", async () => {
    const stub = await stubResolver(deliveryDns([tlsa(2, 0, 1, sha256(ca.raw))]))
    const server = await startTlsServer("chain.pem")
    enable(stub.port)
    try {
      const result = await send(server.port)
      expect(result.tls).toMatchObject({ policy: "dane", outcome: "success" })
      expect(result.ok).toBe(true)
    } finally {
      server.proc.kill()
      stub.stop()
    }
  }, 15000)

  test("a certificate matching no record is deferred with 4.7.5 before MAIL", async () => {
    const stub = await stubResolver(deliveryDns([tlsa(3, 1, 1, sha256(spki(other)))]))
    const server = await startTlsServer("leaf.pem")
    enable(stub.port)
    try {
      const result = await send(server.port)
      expect(result.ok).toBe(false)
      expect(result.retryable).toBe(true)
      expect(result.message).toContain("4.7.5")
      expect(result.tls).toMatchObject({ policy: "dane", outcome: "validation-failure" })
      const seen = await server.seen()
      expect(seen.commands.some((c) => c.endsWith("MAIL"))).toBe(false)
    } finally {
      server.proc.kill()
      stub.stop()
    }
  }, 15000)

  test("STARTTLS missing while TLSA is secure defers instead of sending in cleartext", async () => {
    const commands: string[] = []
    const plain = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.write("220 plain.test ESMTP\r\n")
        },
        data(socket, data) {
          const line = Buffer.from(data).toString("latin1")
          commands.push(line.trim())
          if (line.startsWith("EHLO")) socket.write("250-plain.test\r\n250 SIZE 1000000\r\n")
          else socket.write("250 ok\r\n")
        },
      },
    })
    const stub = await stubResolver(deliveryDns([tlsa(3, 1, 1, sha256(spki(leaf)))]))
    enable(stub.port)
    try {
      const result = await send(plain.port)
      expect(result.ok).toBe(false)
      expect(result.retryable).toBe(true)
      expect(result.tls).toMatchObject({ policy: "dane", outcome: "starttls-not-supported" })
      expect(commands.some((c) => c.startsWith("MAIL"))).toBe(false)
    } finally {
      plain.stop(true)
      stub.stop()
    }
  }, 15000)

  test("an unsigned TLSA answer leaves ordinary opportunistic TLS", async () => {
    const stub = await stubResolver(deliveryDns([tlsa(3, 1, 1, sha256(spki(other)))], false))
    const server = await startTlsServer("leaf.pem")
    enable(stub.port)
    try {
      const result = await send(server.port)
      expect(result.ok).toBe(true)
      expect(result.tls?.policy).toBe("none")
      expect((await server.seen()).commands).toContain("tls:MAIL")
    } finally {
      server.proc.kill()
      stub.stop()
    }
  }, 15000)

  test("a SERVFAIL on the MX lookup defers the whole domain", async () => {
    const stub = await stubResolver(new Map<string, Entry>([["dane.test|15", { rcode: 2 }]]))
    enable(stub.port)
    try {
      const result = await send(1)
      expect(result.ok).toBe(false)
      expect(result.retryable).toBe(true)
      expect(result.tls?.outcome).toBe("dnssec-invalid")
    } finally {
      stub.stop()
    }
  })
})
