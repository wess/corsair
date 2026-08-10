import { describe, expect, test } from "bun:test"
import { normalizeEol, parseMessage } from "../src/mime/index.ts"
import { compile, run, type SieveContext } from "../src/sieve/index.ts"

const raw = normalizeEol(
  [
    "From: Newsletter <news@marketing.example.com>",
    "To: me@wess.io",
    "Cc: team@wess.io",
    "Subject: [SALE] Half price everything",
    "List-Id: <deals.marketing.example.com>",
    "",
    "Body.",
  ].join("\n"),
)

const ctx = (over: Partial<SieveContext> = {}): SieveContext => ({
  message: parseMessage(raw),
  size: raw.length,
  envelopeFrom: "bounces@marketing.example.com",
  envelopeTo: "me@wess.io",
  ...over,
})

describe("compile", () => {
  test("accepts a valid script", () => {
    expect(compile('if header :contains "subject" "sale" { discard; }')).toEqual({ ok: true })
  })

  test("reports the line of a syntax error", () => {
    const result = compile('if header :contains "subject" "sale" {\n  discard\n}')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("line")
  })

  test("rejects an unknown test", () => {
    const result = compile('if nonsense "x" { keep; }')
    expect(result.ok).toBe(false)
  })
})

describe("implicit keep", () => {
  test("a script with no filing action keeps", () => {
    expect(run("", ctx()).keep).toBe(true)
  })

  test("fileinto suppresses the implicit keep", () => {
    const result = run('fileinto "Deals";', ctx())
    expect(result.fileInto).toEqual(["Deals"])
    expect(result.keep).toBe(false)
  })

  test("an explicit keep alongside fileinto delivers to both", () => {
    const result = run('fileinto "Deals"; keep;', ctx())
    expect(result.fileInto).toEqual(["Deals"])
    expect(result.keep).toBe(true)
  })
})

describe("tests", () => {
  test("header :contains is case-insensitive", () => {
    expect(run('if header :contains "Subject" "half price" { discard; }', ctx()).discard).toBe(true)
  })

  test("header :is requires the whole value", () => {
    expect(run('if header :is "subject" "half price" { discard; }', ctx()).discard).toBe(false)
  })

  test("header :matches supports globs", () => {
    expect(run('if header :matches "subject" "[SALE]*" { discard; }', ctx()).discard).toBe(true)
  })

  test("address :domain compares only the domain", () => {
    const script = 'if address :domain :is "from" "marketing.example.com" { fileinto "Ads"; }'
    expect(run(script, ctx()).fileInto).toEqual(["Ads"])
  })

  test("address :localpart compares only the local part", () => {
    const script = 'if address :localpart :is "from" "news" { fileinto "Ads"; }'
    expect(run(script, ctx()).fileInto).toEqual(["Ads"])
  })

  test("envelope reads the envelope, not the From header", () => {
    const script = 'if envelope :localpart :is "from" "bounces" { fileinto "Bounces"; }'
    expect(run(script, ctx()).fileInto).toEqual(["Bounces"])
  })

  test("exists checks every named header", () => {
    expect(run('if exists ["list-id"] { discard; }', ctx()).discard).toBe(true)
    expect(run('if exists ["list-id", "x-nope"] { discard; }', ctx()).discard).toBe(false)
  })

  test("size compares with the K suffix", () => {
    expect(run("if size :under 1K { keep; }", ctx()).keep).toBe(true)
    expect(run("if size :over 1K { discard; }", ctx()).discard).toBe(false)
  })

  test("allof, anyof, and not compose", () => {
    const script = `
      if allof (header :contains "subject" "sale",
                not header :contains "from" "trusted.com")
      { fileinto "Junk"; }
    `
    expect(run(script, ctx()).fileInto).toEqual(["Junk"])
  })
})

describe("control flow", () => {
  test("elsif only runs when the preceding branch did not", () => {
    const script = `
      if header :contains "subject" "nothing" { fileinto "A"; }
      elsif header :contains "subject" "sale" { fileinto "B"; }
      else { fileinto "C"; }
    `
    expect(run(script, ctx()).fileInto).toEqual(["B"])
  })

  test("else runs when no branch matched", () => {
    const script = `
      if header :contains "subject" "nothing" { fileinto "A"; }
      else { fileinto "C"; }
    `
    expect(run(script, ctx()).fileInto).toEqual(["C"])
  })

  test("stop halts the rest of the script", () => {
    const script = 'fileinto "First"; stop; fileinto "Second";'
    expect(run(script, ctx()).fileInto).toEqual(["First"])
  })
})

describe("actions", () => {
  test("flags accumulate and can be removed", () => {
    const script = String.raw`
      addflag ["\\Seen", "\\Flagged"];
      removeflag ["\\Flagged"];
      fileinto "Archive";
    `
    expect(run(script, ctx()).flags).toEqual(["\\Seen"])
  })

  test("fileinto :create is reported to the caller", () => {
    const result = run('fileinto :create "Deep/Nested";', ctx())
    expect(result.createFolders).toBe(true)
    expect(result.fileInto).toEqual(["Deep/Nested"])
  })

  test("redirect only accepts an address", () => {
    const result = run('redirect "other@example.com"; redirect "not-an-address";', ctx())
    expect(result.redirect).toEqual(["other@example.com"])
  })

  test("comments and require are ignored", () => {
    const script = `
      require ["fileinto", "imap4flags"]; # needed
      /* block comment */
      fileinto "Ok";
    `
    expect(run(script, ctx()).fileInto).toEqual(["Ok"])
  })
})
