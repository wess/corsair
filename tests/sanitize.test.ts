import { describe, expect, test } from "bun:test"
import { sanitizeHtml, textToHtml } from "../src/sanitize/index.ts"

/**
 * Every message a mail server accepts is attacker-supplied, and this is what
 * stands between one of them and script execution in a logged-in browser. The
 * tests are adversarial on purpose.
 */

const clean = (html: string, options?: Parameters<typeof sanitizeHtml>[1]) =>
  sanitizeHtml(html, options).html

describe("script execution", () => {
  test("drops a script tag and its contents", () => {
    const out = clean("<p>hi</p><script>alert(1)</script><p>bye</p>")
    expect(out).not.toContain("script")
    expect(out).not.toContain("alert")
    expect(out).toContain("hi")
    expect(out).toContain("bye")
  })

  test("drops every event handler", () => {
    const out = clean('<div onclick="alert(1)" onerror="alert(2)" ONMOUSEOVER="x">hi</div>')
    expect(out).not.toContain("onclick")
    expect(out).not.toContain("onerror")
    expect(out.toLowerCase()).not.toContain("onmouseover")
    expect(out).toContain("hi")
  })

  test("drops an unknown on* handler it has never heard of", () => {
    const out = clean('<div onfuturething="alert(1)">hi</div>')
    expect(out).not.toContain("onfuturething")
  })

  test("refuses a javascript: href", () => {
    const out = clean('<a href="javascript:alert(1)">click</a>')
    expect(out).not.toContain("javascript")
    expect(out).toContain("click")
  })

  test("refuses an obfuscated javascript: scheme", () => {
    // Browsers ignore control characters and whitespace inside a scheme.
    for (const href of [
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "  javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "&#106;avascript:alert(1)",
      "&#x6a;avascript:alert(1)",
    ]) {
      const out = clean(`<a href="${href}">x</a>`)
      expect(out.toLowerCase()).not.toContain("javascript")
    }
  })

  test("refuses a data: URL", () => {
    const out = clean('<a href="data:text/html,<script>alert(1)</script>">x</a>')
    expect(out).not.toContain("data:")
  })

  test("drops style tags, which can exfiltrate", () => {
    const out = clean("<style>body{background:url(http://evil/x)}</style><p>hi</p>")
    expect(out).not.toContain("evil")
    expect(out).toContain("hi")
  })

  test("drops iframes, objects, and forms with their contents", () => {
    const out = clean(
      '<iframe src="http://evil"></iframe><object data="x"></object><form action="http://evil"><input name="p" /></form><p>hi</p>',
    )
    expect(out).not.toContain("iframe")
    expect(out).not.toContain("object")
    expect(out).not.toContain("form")
    expect(out).not.toContain("input")
    expect(out).toContain("hi")
  })

  test("neutralises an svg payload", () => {
    const out = clean('<svg><animate onbegin="alert(1)" /></svg><p>hi</p>')
    expect(out).not.toContain("onbegin")
    expect(out).not.toContain("svg")
  })

  test("a stray closing tag cannot unbalance the output", () => {
    const out = clean("</div></div><p>hi</p>")
    expect(out).toContain("hi")
    expect(out.startsWith("</")).toBe(false)
  })

  test("closes tags the message left open", () => {
    const out = clean("<div><p><b>hi")
    expect(out).toBe("<div><p><b>hi</b></p></div>")
  })

  test("drops a conditional comment whole", () => {
    const out = clean("<!--[if mso]><script>alert(1)</script><![endif]--><p>hi</p>")
    expect(out).not.toContain("alert")
    expect(out).toContain("hi")
  })
})

describe("styles", () => {
  test("keeps presentational CSS", () => {
    const out = clean('<p style="color:red;font-size:14px">hi</p>')
    expect(out).toContain("color:red")
    expect(out).toContain("font-size:14px")
  })

  test("drops anything that can load a URL", () => {
    const out = clean('<p style="background-image:url(http://evil/x);color:red">hi</p>')
    expect(out).not.toContain("evil")
    expect(out).toContain("color:red")
  })

  test("drops position and behaviour", () => {
    const out = clean('<p style="position:fixed;behavior:url(#x);color:red">hi</p>')
    expect(out).not.toContain("position")
    expect(out).not.toContain("behavior")
  })
})

describe("images", () => {
  test("withholds a remote image by default and says so", () => {
    const result = sanitizeHtml('<img src="http://tracker.example/pixel.gif" />')
    expect(result.blockedRemoteImages).toBe(true)
    expect(result.html).toContain("data-blocked-src")
    // No real `src` attribute — matched on a boundary so it does not trip on
    // the "src=" at the end of "data-blocked-src=".
    expect(/(?<![-\w])src=/.test(result.html)).toBe(false)
  })

  test("loads remote images when the reader asks", () => {
    const result = sanitizeHtml('<img src="http://example.com/a.png" />', {
      allowRemoteImages: true,
    })
    expect(result.blockedRemoteImages).toBe(false)
    expect(result.html).toContain('src="http://example.com/a.png"')
  })

  test("resolves an inline cid reference to a fetchable URL", () => {
    const result = sanitizeHtml('<img src="cid:logo@example" />', {
      resolveCid: (cid) => `/api/mail/inline/${encodeURIComponent(cid)}`,
    })
    expect(result.html).toContain("/api/mail/inline/logo%40example")
    expect(result.blockedRemoteImages).toBe(false)
  })

  test("drops a cid reference nothing resolves", () => {
    const result = sanitizeHtml('<img src="cid:missing" />', { resolveCid: () => null })
    expect(result.html).not.toContain("cid:")
  })
})

describe("links", () => {
  test("opens in a new tab without handing over window.opener", () => {
    const out = clean('<a href="https://example.com">x</a>')
    expect(out).toContain('target="_blank"')
    expect(out).toContain("noopener")
  })

  test("keeps mailto", () => {
    expect(clean('<a href="mailto:a@b.com">mail</a>')).toContain("mailto:a@b.com")
  })

  test("drops a relative href, which has nothing to resolve against", () => {
    expect(clean('<a href="/settings">x</a>')).not.toContain("href")
  })
})

describe("text bodies", () => {
  test("escapes markup rather than rendering it", () => {
    const out = textToHtml("<script>alert(1)</script>")
    expect(out).not.toContain("<script>")
    expect(out).toContain("&lt;script&gt;")
  })

  test("linkifies bare URLs", () => {
    const out = textToHtml("see https://example.com for details")
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain("noopener")
  })

  test("marks quoted lines", () => {
    expect(textToHtml("> quoted\nreply")).toContain('class="quoted"')
  })

  test("preserves line breaks", () => {
    expect(textToHtml("one\ntwo")).toContain("<br />")
  })
})
