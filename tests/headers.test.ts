import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { config } from "../src/config/index.ts"

/**
 * The panel and the webmail are the only two documents this process serves that
 * execute JavaScript and render mail that a stranger wrote. They were also the
 * only two responses that came back with no Content Security Policy and no
 * `frame-ancestors`, because `Bun.serve({ routes })` is matched before `fetch`
 * and so bypassed the `withSecurityHeaders` wrapper entirely. The JSON API,
 * which renders nothing, had the full set. Exactly backwards.
 *
 * This boots the real server in a **subprocess** with NODE_ENV=production,
 * because that is the only configuration whose headers matter and the wrapper
 * relaxes itself in development. Asserting against the process the operator
 * actually runs is the whole point — the previous bug was invisible to any test
 * that called `buildFetch()` directly, since the headers are added a layer
 * above it.
 *
 * The MTA-STS policy is asserted here too. It is not a header, but it is the
 * other claim this server makes about its own security posture, and it needs
 * the same harness: a real response from the process an operator runs.
 */

const API = new URL("../src/api/index.ts", import.meta.url).pathname

let proc: ReturnType<typeof Bun.spawn>
let base = ""

/**
 * Waits for the server to announce its own port rather than probing for one.
 * A probe that connects to check whether the port is open consumes the first
 * accept, which is its own flavour of flaky.
 */
const readyPort = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) throw new Error(`server exited before READY:\n${seen}`)
    seen += decoder.decode(value, { stream: true })
    const match = seen.match(/READY (\d+)/)
    if (match) {
      reader.releaseLock()
      return match[1] as string
    }
  }
}

beforeAll(async () => {
  proc = Bun.spawn(
    [
      "bun",
      "-e",
      `import { startApi } from ${JSON.stringify(API)}
       const server = await startApi(0)
       console.log("READY " + server.port)`,
    ],
    {
      env: { ...process.env, NODE_ENV: "production", HOST: "127.0.0.1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  )

  const port = await Promise.race([
    readyPort(proc.stdout as ReadableStream<Uint8Array>),
    Bun.sleep(30_000).then(() => {
      throw new Error("server did not start within 30s")
    }),
  ])
  base = `http://127.0.0.1:${port}`
}, 40_000)

afterAll(() => {
  proc?.kill()
})

const CLIENT_PATHS = ["/app", "/app/domains", "/recover", "/webmail", "/webmail/inbox"]

describe("client document headers", () => {
  test.each(CLIENT_PATHS)("%s is served with a content security policy", async (path) => {
    const res = await fetch(base + path)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toStartWith("text/html")

    const csp = res.headers.get("content-security-policy")
    expect(csp).toBeTruthy()
    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("object-src 'none'")
  })

  test.each(CLIENT_PATHS)("%s cannot be framed", async (path) => {
    const res = await fetch(base + path)
    // Both, deliberately: `frame-ancestors` is the one browsers honour now,
    // X-Frame-Options is what an older one understands.
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
    expect(res.headers.get("x-frame-options")).toBe("DENY")
  })

  test("the JSON API still carries the same headers", async () => {
    const res = await fetch(`${base}/api/nothing-here`)
    expect(res.status).toBe(404)
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'")
  })
})

describe("the bundled client", () => {
  test("references its assets by an absolute path with no traversal", async () => {
    const html = await (await fetch(`${base}/app`)).text()
    const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+\.(?:js|css))"/g)].map((m) => m[1])

    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) {
      // `/../../chunk-x.js` resolved correctly only because browsers normalise
      // it away. Served under a sub-path it would not have.
      expect(ref).not.toContain("/../")
      expect(ref).toStartWith("/chunk-")
    }
  })

  test("has no inline script, so `script-src 'self'` is honest", async () => {
    for (const path of ["/app", "/webmail"]) {
      const html = await (await fetch(base + path)).text()
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?\S[\s\S]*?<\/script>/)
    }
  })

  test("ships React's production build", async () => {
    const html = await (await fetch(`${base}/app`)).text()
    const script = html.match(/src="(\/[^"]+\.js)"/)?.[1]
    expect(script).toBeTruthy()

    const source = await (await fetch(base + (script as string))).text()
    // The development build carries its warning text in full; the production
    // build replaces it with a numbered link. Without an explicit
    // `process.env.NODE_ENV` define, Bun emits the former — 488 KB rather than
    // 257 KB, and a double render under StrictMode on every update.
    expect(source).not.toContain("Invalid hook call")
    expect(source).toContain("react.dev/errors")
  })
})

describe("caching", () => {
  test("a hashed asset is immutable and revalidates to 304", async () => {
    const html = await (await fetch(`${base}/app`)).text()
    const script = html.match(/src="(\/[^"]+\.js)"/)?.[1] as string

    const first = await fetch(base + script)
    expect(first.status).toBe(200)
    expect(first.headers.get("cache-control")).toContain("immutable")

    const etag = first.headers.get("etag")
    expect(etag).toBeTruthy()

    const second = await fetch(base + script, { headers: { "if-none-match": etag as string } })
    expect(second.status).toBe(304)
  })

  test("the HTML shell revalidates rather than being cached", async () => {
    const res = await fetch(`${base}/app`)
    expect(res.headers.get("cache-control")).toContain("no-cache")

    const etag = res.headers.get("etag") as string
    const again = await fetch(`${base}/app`, { headers: { "if-none-match": etag } })
    expect(again.status).toBe(304)
  })
})

describe("what the server advertises about its own TLS", () => {
  /**
   * Three documents describe the same capability, and they have to agree.
   *
   * - The MTA-STS policy promises a sending server that port 25 answers
   *   STARTTLS.
   * - Autoconfig tells Thunderbird which submission port and encryption to use.
   * - Autodiscover tells Outlook the same.
   *
   * Getting any of them wrong is silent and total: a client takes the document
   * as fact, creates the account, and every send fails with nothing pointing
   * back at the cause. Autoconfig named port 587/STARTTLS on a server that does
   * not offer STARTTLS, which is exactly that failure.
   *
   * This asserts they agree with *each other* rather than against a locally
   * computed answer. The server probes its own runtime at startup; this test
   * process has not, so only the server knows. Consistency is the property that
   * matters and it holds on any runtime.
   */
  const documents = async () => {
    const [policy, mozilla, outlook] = await Promise.all([
      fetch(`${base}/.well-known/mta-sts.txt`).then((r) => r.text()),
      fetch(`${base}/mail/config-v1.1.xml?emailaddress=someone@example.com`).then((r) => r.text()),
      fetch(`${base}/autodiscover/autodiscover.xml`, {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body: "<Autodiscover><Request><EMailAddress>someone@example.com</EMailAddress></Request></Autodiscover>",
      }).then((r) => r.text()),
    ])
    return { policy, mozilla, outlook }
  }

  test("the MTA-STS policy is well formed", async () => {
    const { policy } = await documents()
    expect(policy).toContain("version: STSv1")
    expect(policy).toMatch(/^mx: \S+$/m)
    expect(policy).toMatch(/^mode: (none|testing|enforce)$/m)
  })

  test("autoconfig never names a submission port the server does not offer", async () => {
    const { policy, mozilla } = await documents()
    const startTlsAvailable = /^mode: (testing|enforce)$/m.test(policy)

    const outgoing = mozilla.match(
      /<outgoingServer[\s\S]*?<port>(\d+)<\/port>[\s\S]*?<socketType>(\w+)<\/socketType>/,
    )
    expect(outgoing).toBeTruthy()

    const [, port, socket] = outgoing as RegExpMatchArray
    if (startTlsAvailable) {
      expect(socket).toBe("STARTTLS")
      expect(port).toBe(String(config.smtp.submissionPort))
    } else {
      // 465 is not a fallback here, it is the better port: encrypted from the
      // first byte with no upgrade to get wrong.
      expect(socket).toBe("SSL")
      expect(port).toBe(String(config.smtp.submissionTlsPort))
    }
  })

  test("autodiscover agrees with autoconfig", async () => {
    const { mozilla, outlook } = await documents()
    const mozPort = mozilla.match(/<outgoingServer[\s\S]*?<port>(\d+)<\/port>/)?.[1]
    const outPort = outlook.match(/<Type>SMTP<\/Type>[\s\S]*?<Port>(\d+)<\/Port>/)?.[1]

    expect(outPort).toBe(mozPort as string)
  })

  test("incoming ports are always implicit TLS", async () => {
    const { mozilla } = await documents()
    // These never depend on the upgrade: Bun.listen({ tls }) is encrypted from
    // the first byte, which is why 993 and 995 have always worked.
    expect(mozilla).toContain("<socketType>SSL</socketType>")
    expect(mozilla).toMatch(/<incomingServer type="imap">[\s\S]*?<socketType>SSL<\/socketType>/)
    expect(mozilla).toMatch(/<incomingServer type="pop3">[\s\S]*?<socketType>SSL<\/socketType>/)
  })
})
