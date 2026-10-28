import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createAddress, inboxOf } from "../src/addresses/index.ts"
import { isCorrespondent, recordCorrespondents } from "../src/correspondents/index.ts"
import { db } from "../src/db/index.ts"
import * as mime from "../src/mime/index.ts"
import type { Domain } from "../src/schema/index.ts"
import {
  baseDomain,
  checkDomains,
  checkIp,
  classify,
  clearCache,
  extractDomains,
  MAX_DOMAINS,
  type Resolve,
  rejectable,
  reverseIp,
} from "../src/smtp/dnsbl/index.ts"
import {
  checkGreylist,
  clientNet,
  exemption,
  type GreylistInput,
  type Policy,
  step,
} from "../src/smtp/greylist/index.ts"
import { authenticatedFrom, handleMessage } from "../src/smtp/inbound/index.ts"
import type { Envelope } from "../src/smtp/session/index.ts"
import { isJunk, score, spamHeaders } from "../src/smtp/spam/index.ts"
import { getRaw } from "../src/storage/index.ts"
import { messagesIn } from "../src/store/index.ts"

/**
 * Inbound spam handling beyond the content heuristics: blocklists, greylisting,
 * and trusted correspondents. Blocklist answers come from a stub resolver — the
 * point of most of these is the answers a real list gives that are *not*
 * listings, and no resolver this suite can reach gives them on demand.
 */

const stub =
  (answers: Record<string, string[]>): Resolve =>
  async (name) =>
    answers[name] ?? []

// blocklists

describe("blocklist return codes", () => {
  test("a ZEN answer in the public-resolver range is a refusal, never a listing", () => {
    for (const code of ["127.255.255.252", "127.255.255.254", "127.255.255.255"]) {
      expect(classify("zen.spamhaus.org", "ip", "1.2.3.4", [code])).toEqual({
        kind: "refused",
        code,
      })
    }
  })

  test("SBL, CSS, XBL, DROP and PBL map to their categories", () => {
    const of = (code: string) => {
      const v = classify("zen.spamhaus.org", "ip", "1.2.3.4", [code])
      return v.kind === "listed" ? v.listings[0] : null
    }
    expect(of("127.0.0.2")).toMatchObject({ category: "SBL", points: 9, reject: true })
    expect(of("127.0.0.3")).toMatchObject({ category: "SBL CSS", reject: true })
    expect(of("127.0.0.4")).toMatchObject({ category: "XBL", reject: true })
    expect(of("127.0.0.9")).toMatchObject({ category: "SBL DROP", reject: true })
    expect(of("127.0.0.10")).toMatchObject({ category: "PBL", points: 3, reject: false })
    expect(of("127.0.0.11")).toMatchObject({ category: "PBL", reject: false })
  })

  test("an undocumented answer is not a listing", () => {
    // 127.0.0.1 from Spamhaus, a DBL code from an IP zone, and a public address
    // from a resolver that rewrites NXDOMAIN to its own search page.
    for (const code of ["127.0.0.1", "127.0.1.2", "127.0.0.8", "93.184.216.34"]) {
      expect(classify("zen.spamhaus.org", "ip", "1.2.3.4", [code]).kind).toBe("clean")
    }
  })

  test("DBL codes map, and abused-legit domains score far lower", () => {
    const of = (code: string) => {
      const v = classify("dbl.spamhaus.org", "domain", "spam.example.biz", [code])
      return v.kind === "listed" ? v.listings[0]!.points : null
    }
    expect(of("127.0.1.2")).toBe(6)
    expect(of("127.0.1.4")).toBe(9)
    expect(of("127.0.1.102")).toBe(1.5)
    expect(of("127.0.1.106")).toBe(1.5)
    expect(of("127.0.0.2")).toBeNull()
    expect(classify("dbl.spamhaus.org", "domain", "x.biz", ["127.0.1.255"]).kind).toBe("refused")
    expect(classify("dbl.spamhaus.org", "domain", "x.biz", ["127.255.255.254"]).kind).toBe(
      "refused",
    )
  })

  test("one answer naming XBL twice is one listing", () => {
    const v = classify("zen.spamhaus.org", "ip", "1.2.3.4", [
      "127.0.0.4",
      "127.0.0.5",
      "127.0.0.10",
    ])
    expect(v.kind === "listed" && v.listings.map((l) => l.category)).toEqual(["XBL", "PBL"])
  })

  test("another list: 127.0.0.x is listed and 127.0.0.1 is a refusal", () => {
    expect(classify("multi.uribl.com", "domain", "x.biz", ["127.0.0.2"]).kind).toBe("listed")
    expect(classify("multi.uribl.com", "domain", "x.biz", ["127.0.0.1"]).kind).toBe("refused")
    expect(classify("multi.uribl.com", "domain", "x.biz", ["10.0.0.1"]).kind).toBe("clean")
  })
})

describe("blocklist query names", () => {
  test("reverses IPv4, unwraps a mapped address, and spells IPv6 in nibbles", () => {
    expect(reverseIp("1.2.3.4")).toBe("4.3.2.1")
    expect(reverseIp("::ffff:1.2.3.4")).toBe("4.3.2.1")
    expect(reverseIp("2001:db8::1")).toBe(
      "1.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.8.b.d.0.1.0.0.2",
    )
    expect(reverseIp("not an ip")).toBeNull()
  })
})

describe("checking the client", () => {
  test("a listed public client comes back with its listings", async () => {
    clearCache()
    const resolve = stub({ "2.0.0.45.zen.spamhaus.org": ["127.0.0.2", "127.0.0.11"] })
    const listings = await checkIp("45.0.0.2", { zones: ["zen.spamhaus.org"], resolve })
    expect(listings.map((l) => l.category)).toEqual(["SBL", "PBL"])
    expect(rejectable(listings)?.category).toBe("SBL")
  })

  test("a PBL listing alone is never grounds to refuse", async () => {
    clearCache()
    const resolve = stub({ "3.0.0.45.zen.spamhaus.org": ["127.0.0.10"] })
    const listings = await checkIp("45.0.0.3", { zones: ["zen.spamhaus.org"], resolve })
    expect(listings).toHaveLength(1)
    expect(rejectable(listings)).toBeNull()
  })

  test("a refused query is no listing at all, and is reported once", async () => {
    clearCache()
    const resolve: Resolve = async () => ["127.255.255.254"]
    const warn = console.warn
    const said: string[] = []
    console.warn = (m: string) => said.push(m)
    try {
      expect(await checkIp("45.0.0.4", { zones: ["refused.spamhaus.org"], resolve })).toEqual([])
      expect(await checkIp("45.0.0.5", { zones: ["refused.spamhaus.org"], resolve })).toEqual([])
    } finally {
      console.warn = warn
    }
    expect(said).toHaveLength(1)
    expect(said[0]).toContain("SPAM_RESOLVER")
  })

  test("private, loopback and documentation addresses are never asked about", async () => {
    clearCache()
    let asked = 0
    const resolve: Resolve = async () => {
      asked++
      return ["127.0.0.2"]
    }
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "::1", "203.0.113.9"]) {
      expect(await checkIp(ip, { zones: ["zen.spamhaus.org"], resolve })).toEqual([])
    }
    expect(asked).toBe(0)
  })

  test("a resolver that never answers costs the budget and no more", async () => {
    clearCache()
    const resolve: Resolve = () => new Promise(() => {})
    const started = Date.now()
    const listings = await checkIp("45.0.0.6", {
      zones: ["zen.spamhaus.org", "other.example.net"],
      resolve,
      budgetMs: 50,
    })
    expect(listings).toEqual([])
    expect(Date.now() - started).toBeLessThan(500)
  })

  test("answers are cached", async () => {
    clearCache()
    let asked = 0
    const resolve: Resolve = async () => {
      asked++
      return []
    }
    await checkIp("45.0.0.7", { zones: ["zen.spamhaus.org"], resolve })
    await checkIp("45.0.0.7", { zones: ["zen.spamhaus.org"], resolve })
    expect(asked).toBe(1)
  })

  test("a domain listing is found", async () => {
    clearCache()
    const resolve = stub({ "spammy.biz.dbl.spamhaus.org": ["127.0.1.2"] })
    const listings = await checkDomains(["spammy.biz", "fine.org"], {
      zones: ["dbl.spamhaus.org"],
      resolve,
    })
    expect(listings.map((l) => l.subject)).toEqual(["spammy.biz"])
  })
})

describe("domain extraction", () => {
  test("takes the sender first, then link hosts, as registered domain and host", () => {
    const domains = extractDomains({
      senders: ["Mail.Sender.org", null],
      text: "see https://www.shop.co.uk/a and http://user@tracker.biz/x?y",
      html: '<a href="https://click.links.net/r">x</a>',
    })
    expect(domains).toEqual([
      "sender.org",
      "mail.sender.org",
      "links.net",
      "click.links.net",
      "shop.co.uk",
      "www.shop.co.uk",
      "tracker.biz",
    ])
  })

  test("skips IP literals and reserved names", () => {
    expect(
      extractDomains({
        senders: ["far.invalid", "example.com"],
        text: "http://1.2.3.4/ http://intranet/ http://a.test/ http://ok.biz/",
        html: "",
      }),
    ).toEqual(["ok.biz"])
  })

  test("is bounded however many links there are", () => {
    const links = Array.from({ length: 5000 }, (_, i) => `https://h${i}.spam${i}.biz/`).join(" ")
    const domains = extractDomains({ senders: [], text: links, html: "" })
    expect(domains).toHaveLength(MAX_DOMAINS)
    expect(extractDomains({ senders: [], text: links, html: "" }, 3)).toHaveLength(3)
  })

  test("a link past the scan window is not looked at", () => {
    const text = `${"x".repeat(600 * 1024)} https://late.biz/`
    expect(extractDomains({ senders: [], text, html: "" })).toEqual([])
  })

  test("guesses the registered domain without a suffix list", () => {
    expect(baseDomain("a.b.example.com")).toBe("example.com")
    expect(baseDomain("www.shop.co.uk")).toBe("shop.co.uk")
    expect(baseDomain("example.com")).toBe("example.com")
  })
})

describe("listings in the score", () => {
  const message = [
    "From: a@b.org",
    "To: c@d.org",
    "Subject: hi",
    "Date: Mon, 1 Jan 2026 00:00:00 +0000",
    "Message-ID: <x@b.org>",
    "",
    "hello",
    "",
  ].join("\r\n")
  const signals = {
    spf: "pass",
    dkim: "pass",
    dmarc: "pass",
    helo: "mx.b.org",
    remoteIp: "45.0.0.2",
    mailFrom: "a@b.org",
    reverseDns: "mx.b.org",
  }

  test("an SBL listing alone files fully authenticated mail in Junk", () => {
    const clean = score(message, signals)
    const listed = score(message, {
      ...signals,
      listings: [
        {
          zone: "zen.spamhaus.org",
          kind: "ip",
          subject: "45.0.0.2",
          code: "127.0.0.2",
          category: "SBL",
          points: 9,
          reject: true,
        },
      ],
    })
    expect(listed.score).toBe(clean.score + 9)
    expect(isJunk(listed)).toBe(true)
    expect(listed.reasons.at(-1)).toBe("+9 client 45.0.0.2 is on zen.spamhaus.org (SBL)")
  })

  test("a domain list counts once, at its strongest hit", () => {
    const hit = (subject: string, points: number) => ({
      zone: "dbl.spamhaus.org",
      kind: "domain" as const,
      subject,
      code: "127.0.1.2",
      category: "DBL",
      points,
      reject: false,
    })
    const verdict = score(message, {
      ...signals,
      listings: [hit("a.biz", 1.5), hit("b.biz", 4), hit("c.biz", 4)],
    })
    expect(verdict.score).toBe(score(message, signals).score + 4)
    expect(verdict.reasons.filter((r) => r.includes("dbl"))).toEqual([
      "+4 b.biz is on dbl.spamhaus.org (DBL)",
    ])
  })

  test("the header carries every reason and cannot be split by one", () => {
    const header = spamHeaders({ score: 6, reasons: ["+3 one", "+3 two\r\nX-Evil: 1"] })
    expect(header.startsWith("X-Spam-Status: Yes, score=6 required=5\r\n")).toBe(true)
    expect(header.split("\r\n").filter((l) => /^X-Evil/.test(l))).toHaveLength(0)
  })
})

// greylisting

const p: Policy = { delayMs: 5 * 60_000, retryMs: 24 * 3600_000, whitelistMs: 36 * 24 * 3600_000 }
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1) + minutes * 60_000)

describe("the greylist state machine", () => {
  test("defers the first attempt and an early retry, then passes", () => {
    const first = step(null, at(0), p)
    expect(first.verdict).toBe("defer")
    const early = step(first.row, at(2), p)
    expect(early.verdict).toBe("defer")
    expect(early.row.firstSeen).toEqual(at(0))
    const retry = step(early.row, at(6), p)
    expect(retry.verdict).toBe("pass")
    expect(retry.row.passedAt).toEqual(at(6))
  })

  test("a passed triplet stays passed for 36 days of silence and no longer", () => {
    const passed = { firstSeen: at(0), lastSeen: at(6), passedAt: at(6) }
    expect(step(passed, at(6 + 35 * 24 * 60), p).verdict).toBe("pass")
    expect(step(passed, at(6 + 37 * 24 * 60), p).verdict).toBe("defer")
  })

  test("a retry after the 24-hour window starts over", () => {
    const stale = { firstSeen: at(0), lastSeen: at(0), passedAt: null }
    const late = step(stale, at(25 * 60), p)
    expect(late.verdict).toBe("defer")
    expect(late.row.firstSeen).toEqual(at(25 * 60))
  })

  test("keys a client by its /24 or /64", () => {
    expect(clientNet("45.6.7.8")).toBe("45.6.7.0/24")
    expect(clientNet("::ffff:45.6.7.8")).toBe("45.6.7.0/24")
    expect(clientNet("2a01:4f8:1:2:3:4:5:6")).toBe("2a01:4f8:1:2::/64")
  })
})

const octet = () => 1 + Math.floor(Math.random() * 250)
const freshIp = () => `45.${octet()}.${octet()}.10`

const input = (over: Partial<GreylistInput> = {}): GreylistInput => ({
  remoteIp: freshIp(),
  local: false,
  authenticated: false,
  helo: "mx.sender.invalid",
  mailFrom: `s${Math.random().toString(36).slice(2, 8)}@sender-${Math.random().toString(36).slice(2, 6)}.invalid`,
  recipient: "r@here.invalid",
  addressId: null,
  ...over,
})

const spfFail = async () => "fail"
const spfPass = async () => "pass"

describe("greylisting", () => {
  afterAll(async () => {
    await db().execute({ text: "DELETE FROM greylist WHERE client_net LIKE '45.%'", values: [] })
  })

  test("defers first contact with 451 4.7.1 and accepts the retry", async () => {
    const i = input()
    const first = await checkGreylist(i, { spf: spfFail, now: at(0), policy: p })
    expect(first).toMatchObject({ code: 451, enhanced: "4.7.1" })
    expect(await checkGreylist(i, { spf: spfFail, now: at(1), policy: p })).not.toBeNull()
    expect(await checkGreylist(i, { spf: spfFail, now: at(6), policy: p })).toBeNull()
    expect(await checkGreylist(i, { spf: spfFail, now: at(60), policy: p })).toBeNull()
  })

  test("a network that has passed once is not greylisted for another recipient", async () => {
    const i = input()
    await checkGreylist(i, { spf: spfFail, now: at(0), policy: p })
    await checkGreylist(i, { spf: spfFail, now: at(6), policy: p })
    const other = { ...i, recipient: "someone-else@here.invalid", mailFrom: "x@y.invalid" }
    expect(await checkGreylist(other, { spf: spfFail, now: at(7), policy: p })).toBeNull()
  })

  test("the null sender is never greylisted", async () => {
    const i = input({ mailFrom: "" })
    expect(exemption(i)).toBe("null sender")
    expect(await checkGreylist(i, { spf: spfFail, now: at(0), policy: p })).toBeNull()
  })

  test("an authenticated or local session is never greylisted", async () => {
    expect(
      await checkGreylist(input({ authenticated: true }), { spf: spfFail, policy: p }),
    ).toBeNull()
    expect(await checkGreylist(input({ local: true }), { spf: spfFail, policy: p })).toBeNull()
    expect(exemption(input({ remoteIp: "10.0.0.5" }))).toBe("private client")
  })

  test("a correspondent of the recipient skips it, but only when SPF passes", async () => {
    await recordCorrespondents({ id: mailboxId, type: "standard" }, ["buddy@grey.invalid"])
    const i = input({ mailFrom: "Buddy@grey.invalid", addressId: mailboxId })
    expect(await checkGreylist(i, { spf: spfFail, now: at(0), policy: p })).not.toBeNull()
    expect(
      await checkGreylist(input({ ...i, remoteIp: freshIp() }), {
        spf: spfPass,
        now: at(0),
        policy: p,
      }),
    ).toBeNull()
  })

  test("a domain with history skips it, but only when SPF passes", async () => {
    const domain = `hist-${Math.random().toString(36).slice(2, 6)}.invalid`
    const proven = input({ mailFrom: `a@${domain}` })
    await checkGreylist(proven, { spf: spfFail, now: at(0), policy: p })
    await checkGreylist(proven, { spf: spfFail, now: at(6), policy: p })

    const elsewhere = input({ mailFrom: `b@${domain}` })
    expect(await checkGreylist(elsewhere, { spf: spfFail, now: at(10), policy: p })).not.toBeNull()
    const again = input({ mailFrom: `c@${domain}` })
    expect(await checkGreylist(again, { spf: spfPass, now: at(10), policy: p })).toBeNull()
  })
})

// trusted correspondents

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `spam-${suffix}.invalid`
let userId = ""
let domain: Domain
let mailboxId = ""

beforeAll(async () => {
  userId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Spam', $2) RETURNING id`,
    values: [`spam-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id
  domain = (await db().one<Domain>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=spam', 'active') RETURNING *`,
    values: [userId, zone],
  }))!
  mailboxId = (
    await createAddress({
      domainId: domain.id,
      localPart: "me",
      type: "standard",
      password: "correct horse battery staple",
    })
  ).address.id
})

afterAll(async () => {
  await db().execute({ text: "DELETE FROM mail_log WHERE user_id = $1", values: [userId] })
  await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [userId] })
})

describe("recording correspondents", () => {
  test("records each recipient once, case-folded", async () => {
    await recordCorrespondents({ id: mailboxId, type: "standard" }, ["Friend@Far.invalid"])
    await recordCorrespondents({ id: mailboxId, type: "standard" }, ["friend@far.invalid"])
    expect(await isCorrespondent(mailboxId, "FRIEND@far.invalid")).toBe(true)
    const rows = await db().all({
      text: "SELECT 1 FROM correspondents WHERE address_id = $1 AND email = 'friend@far.invalid'",
      values: [mailboxId],
    })
    expect(rows).toHaveLength(1)
  })

  test("keeps only the most recent up to the cap", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "capped",
      type: "standard",
      password: "correct horse battery staple",
    })
    await recordCorrespondents(address, ["one@far.invalid", "two@far.invalid"], 3)
    await db().execute({
      text: "UPDATE correspondents SET last_at = now() - interval '1 day' WHERE address_id = $1",
      values: [address.id],
    })
    await recordCorrespondents(address, ["three@far.invalid", "four@far.invalid"], 3)
    const kept = await db().all<{ email: string }>({
      text: "SELECT email FROM correspondents WHERE address_id = $1",
      values: [address.id],
    })
    expect(kept).toHaveLength(3)
    expect(kept.map((r) => r.email)).toContain("three@far.invalid")
  })

  test("an agent's sends are not recorded", async () => {
    await recordCorrespondents({ id: mailboxId, type: "agent" }, ["stranger@far.invalid"])
    expect(await isCorrespondent(mailboxId, "stranger@far.invalid")).toBe(false)
  })
})

describe("the authenticated From", () => {
  const parsed = (from: string) => mime.parseMessage(`From: ${from}\r\nSubject: x\r\n\r\nhi\r\n`)

  test("needs SPF or DKIM to pass for the From domain", () => {
    const from = parsed("Friend <friend@far.invalid>")
    expect(
      authenticatedFrom(from, "friend@far.invalid", {
        spf: "pass",
        dkim: "none",
        dkimDomain: null,
      }),
    ).toBe("friend@far.invalid")
    expect(
      authenticatedFrom(from, "bounce@mail.far.invalid", {
        spf: "none",
        dkim: "pass",
        dkimDomain: "far.invalid",
      }),
    ).toBe("friend@far.invalid")
  })

  test("a forged From of a known correspondent is not authenticated", () => {
    const from = parsed("friend@far.invalid")
    // SPF passes, but for the forger's own domain.
    expect(
      authenticatedFrom(from, "x@forger.invalid", { spf: "pass", dkim: "none", dkimDomain: null }),
    ).toBeNull()
    // A valid signature, by the forger.
    expect(
      authenticatedFrom(from, "x@forger.invalid", {
        spf: "fail",
        dkim: "pass",
        dkimDomain: "forger.invalid",
      }),
    ).toBeNull()
    // Nothing passes at all.
    expect(
      authenticatedFrom(from, "friend@far.invalid", {
        spf: "softfail",
        dkim: "fail",
        dkimDomain: "far.invalid",
      }),
    ).toBeNull()
  })
})

describe("mail from a correspondent", () => {
  const envelope = (from: string): Envelope => ({
    helo: "mx.far.invalid",
    mailFrom: from,
    hasSender: true,
    rcptTo: [`me@${zone}`],
    size: null,
    smtputf8: false,
  })
  const message = (from: string, subject: string) =>
    [
      `From: ${from}`,
      `To: me@${zone}`,
      `Subject: ${subject}`,
      "Date: Mon, 1 Jan 2026 00:00:00 +0000",
      `Message-ID: <${subject}@far.invalid>`,
      "",
      "hello",
      "",
    ].join("\r\n")

  const delivered = async (subject: string) => {
    const rows = await messagesIn((await inboxOf(mailboxId)).id)
    const row = rows.find((r) => r.subject === subject)!
    return {
      score: Number(row.spam_score),
      raw: (await getRaw({ storageKey: row.storage_key, messageId: row.id }))!,
    }
  }

  test("is scored down when authenticated, and says why", async () => {
    await recordCorrespondents({ id: mailboxId, type: "standard" }, ["pal@far.invalid"])
    // A loopback session is SPF-exempt, which is the one way to get a pass here
    // without DNS.
    const ctx = { remoteIp: "127.0.0.1", local: true, helo: "mx.far.invalid" }
    await handleMessage(envelope("pal@far.invalid"), message("pal@far.invalid", "known"), ctx)
    await handleMessage(
      envelope("unknown@far.invalid"),
      message("unknown@far.invalid", "unknown"),
      ctx,
    )
    const known = await delivered("known")
    const unknown = await delivered("unknown")
    expect(known.score).toBe(unknown.score - 5)
    expect(known.raw).toContain("pal@far.invalid is a correspondent of this mailbox")
    expect(known.raw.indexOf("X-Spam-Status:")).toBeLessThan(known.raw.indexOf("From:"))
  })

  test("is not scored down when the From is forged", async () => {
    await recordCorrespondents({ id: mailboxId, type: "standard" }, ["pal@far.invalid"])
    const ctx = { remoteIp: "203.0.113.9", helo: "mx.forger.invalid" }
    await handleMessage(envelope("x@forger.invalid"), message("pal@far.invalid", "forged"), ctx)
    const forged = await delivered("forged")
    expect(forged.raw).not.toContain("correspondent")
  })
})
