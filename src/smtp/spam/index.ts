import * as mime from "../../mime/index.ts"

/**
 * A small heuristic spam scorer.
 *
 * This is deliberately not a Bayesian filter or a rules engine — running one of
 * those properly means training data, corpus management, and a feedback loop,
 * and a half-hearted version is worse than none because it produces
 * false positives on mail people care about. What is here scores the signals
 * that are cheap, stable, and mostly about *authentication* rather than
 * content: an unauthenticated sender claiming a domain that publishes a policy
 * is the strongest signal available, and it needs no corpus.
 *
 * Anything above `JUNK_THRESHOLD` is filed in Junk rather than rejected.
 * Rejecting on a heuristic score loses real mail silently.
 */

export const JUNK_THRESHOLD = 5

export type SpamSignals = {
  spf: string
  dkim: string
  dmarc: string
  helo: string
  remoteIp: string
  mailFrom: string
  reverseDns: string | null
}

export type SpamVerdict = { score: number; reasons: string[] }

const SHOUTY = /^[^a-z]*$/

export const score = (raw: string, signals: SpamSignals): SpamVerdict => {
  const parsed = mime.parseMessage(raw)
  const reasons: string[] = []
  let total = 0

  const add = (points: number, reason: string) => {
    total += points
    reasons.push(`${points > 0 ? "+" : ""}${points} ${reason}`)
  }

  // ------------------------------------------------------------- identity --

  if (signals.dmarc === "fail") add(4, "DMARC alignment failed")
  else if (signals.dmarc === "pass") add(-2, "DMARC passed")

  if (signals.spf === "fail") add(3, "SPF failed")
  else if (signals.spf === "softfail") add(1, "SPF soft-failed")
  else if (signals.spf === "pass") add(-1, "SPF passed")

  if (signals.dkim === "fail") add(2, "DKIM signature did not verify")
  else if (signals.dkim === "pass") add(-1, "DKIM passed")
  else if (signals.dkim === "none") add(0.5, "no DKIM signature")

  if (!signals.reverseDns) add(1.5, "no reverse DNS for the sending IP")

  // A HELO that is a bare IP or has no dot is a bot; every real MTA introduces
  // itself with a hostname.
  if (!signals.helo.includes(".") || /^\[?\d+\.\d+\.\d+\.\d+\]?$/.test(signals.helo)) {
    add(1.5, "HELO is not a hostname")
  }

  // -------------------------------------------------------------- headers --

  const from = mime.headerValue(parsed.headers, "from")
  const subject = mime.decodeWords(mime.headerValue(parsed.headers, "subject") ?? "")

  if (!from) add(2, "no From header")
  if (!mime.headerValue(parsed.headers, "message-id")) add(1, "no Message-ID")
  if (!mime.headerValue(parsed.headers, "date")) add(1, "no Date header")

  // The envelope sender and the From domain disagreeing is normal for mailing
  // lists, so it is a mild signal rather than a strong one.
  const fromDomain = mime.parseAddressList(from)[0]?.address.split("@")[1]?.toLowerCase()
  const envelopeDomain = signals.mailFrom.split("@")[1]?.toLowerCase()
  if (fromDomain && envelopeDomain && fromDomain !== envelopeDomain) {
    add(0.5, "From and envelope sender domains differ")
  }

  if (subject.length > 4 && SHOUTY.test(subject)) add(1, "subject is all upper case")
  if (/[Ѐ-ӿ一-鿿]/.test(subject) && /[a-z]/i.test(subject)) {
    add(0.5, "subject mixes scripts")
  }

  // --------------------------------------------------------------- bodies --

  const { text, html } = mime.bodyText(raw, parsed)
  const body = text || html

  if (!body.trim()) add(1, "empty body")

  if (html && !text) add(0.5, "HTML with no plain-text alternative")

  // A link whose visible text is a different host than its href is the classic
  // phishing shape and one of the few content signals worth trusting.
  for (const match of html.matchAll(
    /<a[^>]+href=["']?(https?:\/\/[^"'\s>]+)["']?[^>]*>([^<]*)</gi,
  )) {
    const href = match[1] ?? ""
    const label = (match[2] ?? "").trim()
    if (!/^https?:\/\//i.test(label)) continue
    const hrefHost = href.match(/^https?:\/\/([^/?#]+)/i)?.[1]?.toLowerCase()
    const labelHost = label.match(/^https?:\/\/([^/?#]+)/i)?.[1]?.toLowerCase()
    if (hrefHost && labelHost && hrefHost !== labelHost) {
      add(3, "a link's text points at a different host than its target")
      break
    }
  }

  const rounded = Math.round(total * 10) / 10
  return { score: rounded, reasons }
}

export const isJunk = (verdict: SpamVerdict): boolean => verdict.score >= JUNK_THRESHOLD
