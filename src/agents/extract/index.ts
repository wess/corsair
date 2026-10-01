/**
 * Pulls the two things an agent reads a signup email for: the link to click and
 * the code to type.
 *
 * Both are heuristics over text an attacker may have written, so they only
 * ever *suggest* — the whole body is returned beside them. A wrong guess costs
 * the agent a second look; a missed one costs it the signup.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/gi
const HREF_PATTERN = /href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

// Sentence punctuation that ends up glued to the end of a bare URL in prose.
const TRAILING = /[.,;:!?)\]}>]+$/

const clean = (url: string): string => url.replace(TRAILING, "")

const decodeEntities = (value: string): string =>
  value
    .replace(/&amp;/gi, "&")
    .replace(/&#38;/g, "&")
    .replace(/&#x26;/gi, "&")

/** Every http(s) link in the message, in the order they appear, once each. */
export const extractLinks = (input: { text: string; html: string }): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (candidate: string) => {
    const url = clean(decodeEntities(candidate.trim()))
    if (!/^https?:\/\/\S+$/i.test(url) || seen.has(url)) return
    seen.add(url)
    out.push(url)
  }

  // The plain-text part is what a person would read; the HTML's hrefs catch the
  // button whose visible label is "Verify" and whose URL appears nowhere else.
  for (const match of input.text.matchAll(URL_PATTERN)) add(match[0])
  for (const match of input.html.matchAll(HREF_PATTERN)) add(match[1] ?? match[2] ?? "")
  return out
}

// "Your code is 482913", "verification code: 482 913", "OTP 4829", "482913 is
// your code". Up to eight digits, optionally split by one space or hyphen, the
// way providers format them for reading aloud.
const DIGITS = String.raw`(\d{3,4}[ -]?\d{2,4}|\d{4,8})`
const AFTER_KEYWORD = new RegExp(
  String.raw`\b(?:code|otp|pin|passcode|password|token)\b[^\d\r\n]{0,40}?\b${DIGITS}\b`,
  "gi",
)
const BEFORE_KEYWORD = new RegExp(String.raw`\b${DIGITS}\b[^\r\n]{0,20}?\b(?:is|as)\s+your\b`, "gi")

/** Numeric verification codes, digits only, most likely first. */
export const extractCodes = (text: string): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const pattern of [AFTER_KEYWORD, BEFORE_KEYWORD]) {
    for (const match of text.matchAll(pattern)) {
      const code = match[1]!.replace(/\D/g, "")
      // A year or a short number is far more likely than a code; real ones are
      // 4 to 8 digits and a four-digit one that looks like a year is dropped.
      if (code.length < 4 || code.length > 8) continue
      if (code.length === 4 && /^(19|20)\d\d$/.test(code)) continue
      if (seen.has(code)) continue
      seen.add(code)
      out.push(code)
    }
  }
  return out
}
