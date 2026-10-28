import { afterEach, describe, expect, test } from "bun:test"
import { buildFetch } from "../src/api/index.ts"
import { recordAuthFailure } from "../src/auth/index.ts"
import { createImapSession } from "../src/imap/session/index.ts"
import {
  commandName,
  createRegistry,
  deferralReason,
  escapeLabel,
  registry,
  smtpReason,
} from "../src/metrics/index.ts"
import { createSession } from "../src/smtp/session/index.ts"

const seriesValue = (text: string, series: string): number => {
  const line = text.split("\n").find((l) => l.startsWith(`${series} `))
  return line ? Number(line.slice(series.length + 1)) : 0
}

describe("registry and renderer", () => {
  test("counters render HELP, TYPE and labelled samples", async () => {
    const r = createRegistry()
    const c = r.counter("things_total", "Things seen.", ["kind"])
    c.inc({ kind: "a" })
    c.inc({ kind: "a" }, 2)
    c.inc({ kind: "b" })
    expect(await r.render()).toBe(
      [
        "# HELP things_total Things seen.",
        "# TYPE things_total counter",
        'things_total{kind="a"} 3',
        'things_total{kind="b"} 1',
        "",
      ].join("\n"),
    )
  })

  test("label values and help text are escaped", async () => {
    expect(escapeLabel('a\\b"c\nd')).toBe('a\\\\b\\"c\\nd')
    const r = createRegistry()
    r.counter("odd_total", "Line one\nline two \\ done.", ["v"]).inc({ v: 'x"y\nz\\' })
    const out = await r.render()
    expect(out).toContain("# HELP odd_total Line one\\nline two \\\\ done.")
    expect(out).toContain('odd_total{v="x\\"y\\nz\\\\"} 1')
  })

  test("gauges set, inc and dec; reset clears the series", async () => {
    const r = createRegistry()
    const g = r.gauge("open", "Open things.", ["p"])
    g.inc({ p: "x" })
    g.inc({ p: "x" })
    g.dec({ p: "x" })
    g.set({ p: "y" }, 7)
    const out = await r.render()
    expect(out).toContain('open{p="x"} 1')
    expect(out).toContain('open{p="y"} 7')
    g.reset()
    expect(await r.render()).not.toContain("open{")
  })

  test("histograms are cumulative with +Inf, sum and count", async () => {
    const r = createRegistry()
    const h = r.histogram("size", "Sizes.", [10, 100], ["l"])
    for (const v of [5, 10, 50, 500]) h.observe({ l: "mx" }, v)
    const out = await r.render()
    expect(out).toContain("# TYPE size histogram")
    expect(out).toContain('size_bucket{l="mx",le="10"} 2')
    expect(out).toContain('size_bucket{l="mx",le="100"} 3')
    expect(out).toContain('size_bucket{l="mx",le="+Inf"} 4')
    expect(out).toContain('size_sum{l="mx"} 565')
    expect(out).toContain('size_count{l="mx"} 4')
  })

  test("a metric stops growing at the series cap", async () => {
    const r = createRegistry()
    const c = r.counter("capped_total", "Capped.", ["id"])
    for (let i = 0; i < 2000; i++) c.inc({ id: String(i) })
    const lines = (await r.render()).split("\n").filter((l) => l.startsWith("capped_total{"))
    expect(lines.length).toBe(500)
  })

  test("registering a name twice throws", () => {
    const r = createRegistry()
    r.counter("dup_total", "x")
    expect(() => r.gauge("dup_total", "x")).toThrow()
  })

  test("command names outside the whitelist fold into other", () => {
    expect(commandName("imap", "fetch")).toBe("FETCH")
    expect(commandName("imap", "X-HACK-123")).toBe("other")
    expect(commandName("pop3", "RETR")).toBe("RETR")
    expect(commandName("jmap", "Email/get")).toBe("Email/get")
    expect(commandName("jmap", "Email/../../x")).toBe("other")
  })

  test("reason classes", () => {
    expect(smtpReason({ code: 552, message: "Message exceeds the limit." })).toBe("size")
    expect(smtpReason({ code: 550, message: "Rejected as spam." })).toBe("spam")
    expect(smtpReason({ code: 535, message: "Bad credentials." })).toBe("auth")
    expect(smtpReason({ code: 550, enhanced: "5.7.1", message: "Relay access denied." })).toBe(
      "policy",
    )
    expect(smtpReason({ code: 550, enhanced: "5.1.1", message: "No such user here." })).toBe(
      "other",
    )
    expect(deferralReason(554, "blocked using zen.spamhaus.org")).toBe("blocklist")
    expect(deferralReason(451, "TLS handshake failed")).toBe("tls")
    expect(deferralReason(0, "connect ECONNREFUSED")).toBe("connect")
    expect(deferralReason(451, "greylisted, try later")).toBe("4xx")
    expect(deferralReason(null, "strange")).toBe("other")
  })
})

describe("GET /metrics", () => {
  const app = buildFetch(null)
  const saved = process.env.METRICS_TOKEN
  afterEach(() => {
    if (saved === undefined) delete process.env.METRICS_TOKEN
    else process.env.METRICS_TOKEN = saved
  })

  const get = (headers: Record<string, string> = {}) =>
    app(new Request("http://localhost:3000/metrics", { headers }))

  test("is a 404 when METRICS_TOKEN is not set", async () => {
    delete process.env.METRICS_TOKEN
    expect((await get({ authorization: "Bearer anything" })).status).toBe(404)
  })

  test("is a 401 for a missing or wrong token", async () => {
    process.env.METRICS_TOKEN = "scrape-secret"
    expect((await get()).status).toBe(401)
    expect((await get({ authorization: "Bearer nope" })).status).toBe(401)
    expect((await get({ authorization: "Bearer scrape-secre" })).status).toBe(401)
  })

  test("serves the exposition for the right token", async () => {
    process.env.METRICS_TOKEN = "scrape-secret"
    const res = await get({ authorization: "Bearer scrape-secret" })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toStartWith("text/plain; version=0.0.4")
    expect(res.headers.get("cache-control")).toBe("no-store")
    const body = await res.text()
    expect(body).toContain("# TYPE corsair_process_uptime_seconds gauge")
    expect(body).toContain("corsair_build_info{version=")
    expect(body).toContain("corsair_process_resident_memory_bytes")
  })
})

describe("instrumentation", () => {
  const scrape = () => registry.render()

  test("a failed login is counted by protocol", async () => {
    const before = seriesValue(
      await scrape(),
      'corsair_auth_attempts_total{protocol="imap",result="fail"}',
    )
    await recordAuthFailure("203.0.113.77", "imap", "nobody@metrics.invalid")
    const after = seriesValue(
      await scrape(),
      'corsair_auth_attempts_total{protocol="imap",result="fail"}',
    )
    expect(after).toBe(before + 1)
  })

  test("IMAP commands are counted, unknown ones as other", async () => {
    const session = createImapSession({
      isSecure: () => true,
      remoteIp: "203.0.113.9",
      push: () => {},
    })
    const cap = 'corsair_commands_total{protocol="imap",command="CAPABILITY"}'
    const other = 'corsair_commands_total{protocol="imap",command="other"}'
    const [c0, o0] = [seriesValue(await scrape(), cap), seriesValue(await scrape(), other)]
    await session.feed("a1 CAPABILITY\r\n")
    await session.feed("a2 XWHATEVER-1234\r\n")
    const text = await scrape()
    expect(seriesValue(text, cap)).toBe(c0 + 1)
    expect(seriesValue(text, other)).toBe(o0 + 1)
  })

  test("SMTP messages are counted by result and size is observed", async () => {
    let accept = true
    const session = createSession({
      mode: "mx",
      listener: "mx",
      hostname: "mx.test",
      maxSize: 4096,
      remoteIp: "203.0.113.9",
      isSecure: () => false,
      validateSender: async () => null,
      validateRecipient: async () => null,
      handleMessage: async () =>
        accept
          ? { code: 250, message: "Queued." }
          : { code: 550, enhanced: "5.7.1", message: "Rejected as spam." },
    })
    const ok = 'corsair_smtp_messages_total{listener="mx",result="accepted",reason="none"}'
    const spam = 'corsair_smtp_messages_total{listener="mx",result="rejected",reason="spam"}'
    const count = 'corsair_smtp_message_size_bytes_count{listener="mx"}'
    const t0 = await scrape()
    const [a0, s0, n0] = [seriesValue(t0, ok), seriesValue(t0, spam), seriesValue(t0, count)]

    const send = () =>
      session.feed(
        "EHLO c.test\r\nMAIL FROM:<a@b.test>\r\nRCPT TO:<x@y.test>\r\nDATA\r\nSubject: hi\r\n\r\nbody\r\n.\r\n",
      )
    await send()
    accept = false
    await send()

    const t1 = await scrape()
    expect(seriesValue(t1, ok)).toBe(a0 + 1)
    expect(seriesValue(t1, spam)).toBe(s0 + 1)
    expect(seriesValue(t1, count)).toBe(n0 + 2)
  })
})
