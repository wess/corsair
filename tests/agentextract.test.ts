import { describe, expect, test } from "bun:test"
import { extractCodes, extractLinks } from "../src/agents/extract/index.ts"

describe("verification codes", () => {
  const codes = (text: string) => extractCodes(text)

  test("finds a code after its keyword", () => {
    expect(codes("Your verification code is 482913. It expires in 10 minutes.")).toEqual(["482913"])
    expect(codes("OTP: 4829")).toEqual(["4829"])
  })

  test("finds a code that comes first", () => {
    expect(codes("482913 is your Acme verification code")).toEqual(["482913"])
  })

  test("joins a code split for reading aloud", () => {
    expect(codes("Your code: 482 913")).toEqual(["482913"])
    expect(codes("Your code: 482-913")).toEqual(["482913"])
  })

  test("does not mistake a year or a phone-length number for a code", () => {
    expect(codes("Confirmation code for your 2026 renewal")).toEqual([])
    expect(codes("Your code is 12345678901")).toEqual([])
  })

  test("returns nothing for a message with no code", () => {
    expect(codes("Welcome aboard! Click the button to confirm your email.")).toEqual([])
  })
})

describe("links", () => {
  test("takes bare URLs and strips sentence punctuation", () => {
    expect(extractLinks({ text: "Confirm here: https://a.test/verify?t=1.", html: "" })).toEqual([
      "https://a.test/verify?t=1",
    ])
  })

  test("takes a button's href and decodes the ampersands in it", () => {
    const html = `<a href="https://a.test/v?t=1&amp;u=2">Verify</a>`
    expect(extractLinks({ text: "", html })).toEqual(["https://a.test/v?t=1&u=2"])
  })

  test("lists each link once, text first", () => {
    const out = extractLinks({
      text: "https://a.test/x",
      html: `<a href="https://a.test/x">x</a><a href="https://b.test/y">y</a>`,
    })
    expect(out).toEqual(["https://a.test/x", "https://b.test/y"])
  })

  test("ignores mailto and javascript hrefs", () => {
    const html = `<a href="mailto:a@b.test">m</a><a href="javascript:alert(1)">j</a>`
    expect(extractLinks({ text: "", html })).toEqual([])
  })
})
