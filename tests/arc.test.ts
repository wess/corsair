import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@wess/atlas/db/query"
import { createAddress } from "../src/addresses/index.ts"
import { dmarcOverride, MAX_INSTANCE, seal, verifyChain } from "../src/arc/index.ts"
import { db } from "../src/db/index.ts"
import { dkimRecord, generateKeyPair } from "../src/dkim/index.ts"
import { inlineBody } from "../src/outbound/index.ts"
import { filters, users } from "../src/schema/index.ts"
import { handleMessage } from "../src/smtp/inbound/index.ts"
import type { Envelope } from "../src/smtp/session/index.ts"
import { score } from "../src/smtp/spam/index.ts"

/**
 * ARC verification, sealing, and the local-policy override. The wire format is
 * pinned independently in `tests/arcwire.test.ts`; this file is about behaviour,
 * and its last block runs the real forwarding path against Postgres.
 */

const RAW = [
  "From: Alice <alice@far.invalid>",
  "To: list@example.invalid",
  "Subject: hello",
  "Date: Wed, 12 Aug 2026 12:00:00 +0000",
  "Message-ID: <arc-test@far.invalid>",
  "",
  "body",
  "",
].join("\r\n")

const keys = { a: generateKeyPair(), b: generateKeyPair() }
const records: Record<string, string> = {
  "a.invalid": dkimRecord(keys.a.publicKey),
  "b.invalid": dkimRecord(keys.b.publicKey),
}
const lookup = async (domain: string) => records[domain] ?? null

const sealAs = (raw: string, who: "a" | "b", chain: Parameters<typeof seal>[0]["chain"]) =>
  seal({
    raw,
    chain,
    authservId: `mx.${who}.invalid`,
    results: "spf=pass; dkim=pass; dmarc=pass",
    domain: `${who}.invalid`,
    selector: "corsair-1",
    privateKey: keys[who].privateKey,
  })

describe("verifying a chain", () => {
  test("a message with no ARC header is none", async () => {
    expect((await verifyChain(RAW, undefined, { lookup })).result).toBe("none")
  })

  test("one seal round-trips", async () => {
    const sealed = sealAs(RAW, "a", { result: "none", instance: 0, lastCv: null })
    const chain = await verifyChain(sealed, undefined, { lookup })
    expect(chain).toMatchObject({ result: "pass", instance: 1, sealer: "a.invalid" })
  })

  test("two hops pass, and the newest sealer is the one reported", async () => {
    const one = sealAs(RAW, "a", { result: "none", instance: 0, lastCv: null })
    // The second hop changes the body, which is exactly what ARC is for.
    const modified = `${one}-- \r\nfooter\r\n`
    const chain1 = await verifyChain(modified, undefined, { lookup })
    // Its AMS no longer matches — the message changed after hop one sealed it.
    expect(chain1.result).toBe("fail")

    const two = sealAs(modified, "b", await verifyChain(one, undefined, { lookup }))
    const chain2 = await verifyChain(two, undefined, { lookup })
    expect(chain2).toMatchObject({ result: "pass", instance: 2, sealer: "b.invalid" })
  })

  test("a body changed after the newest seal fails", async () => {
    const sealed = sealAs(RAW, "a", { result: "none", instance: 0, lastCv: null })
    const tampered = sealed.replace(/body\r\n$/, "bodY\r\n")
    const chain = await verifyChain(tampered, undefined, { lookup })
    expect(chain.result).toBe("fail")
    expect(chain.reason).toContain("body hash")
  })

  test("a changed ARC-Authentication-Results breaks the seal", async () => {
    const sealed = sealAs(RAW, "a", { result: "none", instance: 0, lastCv: null })
    const forged = sealed.replace("dmarc=pass", "dmarc=fail")
    expect((await verifyChain(forged, undefined, { lookup })).reason).toContain("seal 1")
  })

  test("a missing key, a duplicate set, and a gap in instances all fail", async () => {
    const sealed = sealAs(RAW, "a", { result: "none", instance: 0, lastCv: null })
    expect((await verifyChain(sealed, undefined, { lookup: async () => null })).result).toBe("fail")

    const seal1 = sealed.slice(0, sealed.indexOf("\r\nARC-Message-Signature"))
    expect((await verifyChain(`${seal1}\r\n${sealed}`, undefined, { lookup })).result).toBe("fail")

    const gap = sealed.replaceAll("i=1;", "i=2;")
    expect((await verifyChain(gap, undefined, { lookup })).reason).toContain("instance 1")
  })

  test("i=1 must say cv=none", async () => {
    const wrong = sealAs(RAW, "a", { result: "pass", instance: 0, lastCv: null })
    expect((await verifyChain(wrong, undefined, { lookup })).reason).toContain("cv=pass")
  })
})

describe("sealing", () => {
  test("adds nothing once the newest seal says cv=fail", () => {
    const failed = sealAs(RAW, "a", { result: "fail", instance: 0, lastCv: null })
    expect(failed).not.toBe(RAW)
    expect(sealAs(failed, "b", { result: "fail", instance: 1, lastCv: "fail" })).toBe(failed)
  })

  test(`stops at i=${MAX_INSTANCE}`, () => {
    expect(sealAs(RAW, "a", { result: "pass", instance: MAX_INSTANCE, lastCv: "pass" })).toBe(RAW)
  })

  test("a line break in what we stamp cannot inject a header", () => {
    const sealed = seal({
      raw: RAW,
      chain: { result: "none", instance: 0, lastCv: null },
      authservId: "mx.a.invalid\r\nBcc: victim@x.invalid",
      results: "spf=pass\r\nX-Injected: yes",
      domain: "a.invalid",
      selector: "corsair-1",
      privateKey: keys.a.privateKey,
    })
    expect(sealed).not.toMatch(/^Bcc:/m)
    expect(sealed).not.toMatch(/^X-Injected:/m)
  })
})

describe("a published test vector", () => {
  // `cv_pass_i2_1` from ValiMail's ARC test suite (github.com/ValiMail/arc_test_suite,
  // MIT licensed), signed by another implementation entirely. Its i=2 message
  // signature lists arc-authentication-results in h=, so it also pins the
  // bottom-up selection rule this verifier shares with DKIM.
  const vector = [
    "MIME-Version: 1.0",
    "ARC-Seal: a=rsa-sha256;",
    "    b=IAqZJ5HwfNxxsrn9R4ayQgiu9RibPKEUVevbt7XFTkSh1baJ533D2Z6IZ2NaBreUhDBb2e",
    "    K9Gtcv+eyUhWkD8VTmE6fq/F8CDIK3ScIiJykF8hNL1wpa/mGwWWwBnkozIJGAbTAAX7AgnH",
    "    knAehnSW99TeU0lmib0XmOt4TN3sY=; cv=pass; d=example.org; i=2; s=dummy;",
    "    t=12346",
    "ARC-Message-Signature: a=rsa-sha256;",
    "    b=2cDGNznUmp4YSSThCe9nrQIH2Gpd5qPFw3OU8sWFzZgEQ5UZtaVQifVUXUrsSyEzjro3Ul",
    "    YPPDx+C1K+LbKRlOZ06il4ws2zlPafsrx1piKsKSCUq0KjFs01hYCDBa3tfdyITSfoWu2HHY",
    "    pCjrhPMPH1jruIdBV/5Gk2Fvy+mW8=;",
    "    bh=KWSe46TZKCcDbH4klJPo+tjk5LWJnVRlP5pvjXFZYLQ=; c=relaxed/relaxed;",
    "    d=example.org; h=from:to:date:subject:mime-version:arc-authentication-results;",
    "    i=2; s=dummy; t=12346",
    "ARC-Authentication-Results: i=2; lists.example.org;",
    "    spf=pass smtp.mfrom=jqd@d1.example;",
    "    dkim=pass (1024-bit key) header.i=@d1.example;",
    "    dmarc=pass",
    "Received: by 10.157.11.240 with SMTP id 103csp420860oth;",
    "    Fri, 6 Jan 2017 14:27:31 -0800 (PST)",
    "ARC-Seal: a=rsa-sha256;",
    "    b=dOdFEyhrk/tw5wl3vMIogoxhaVsKJkrkEhnAcq2XqOLSQhPpGzhGBJzR7k1sWGokon3TmQ",
    "    7TX9zQLO6ikRpwd/pUswiRW5DBupy58fefuclXJAhErsrebfvfiueGyhHXV7C1LyJTztywzn",
    "    QGG4SCciU/FTlsJ0QANrnLRoadfps=; cv=none; d=example.org; i=1; s=dummy;",
    "    t=12345",
    "ARC-Message-Signature: a=rsa-sha256;",
    "    b=QsRzR/UqwRfVLBc1TnoQomlVw5qi6jp08q8lHpBSl4RehWyHQtY3uOIAGdghDk/mO+/Xpm",
    "    9JA5UVrPyDV0f+2q/YAHuwvP11iCkBQkocmFvgTSxN8H+DwFFPrVVUudQYZV7UDDycXoM6UE",
    "    cdfzLLzVNPOAHEDIi/uzoV4sUqZ18=;",
    "    bh=KWSe46TZKCcDbH4klJPo+tjk5LWJnVRlP5pvjXFZYLQ=; c=relaxed/relaxed;",
    "    d=example.org; h=from:to:date:subject:mime-version:arc-authentication-results;",
    "    i=1; s=dummy; t=12345",
    "ARC-Authentication-Results: i=1; lists.example.org;",
    "    spf=pass smtp.mfrom=jqd@d1.example;",
    "    dkim=pass (1024-bit key) header.i=@d1.example;",
    "    dmarc=pass",
    "Received: from segv.d1.example (segv.d1.example [72.52.75.15])",
    "    by lists.example.org (8.14.5/8.14.5) with ESMTP id t0EKaNU9010123",
    "    for <arc@example.org>; Thu, 14 Jan 2015 15:01:30 -0800 (PST)",
    "    (envelope-from jqd@d1.example)",
    "Authentication-Results: lists.example.org;",
    "    spf=pass smtp.mfrom=jqd@d1.example;",
    "    dkim=pass (1024-bit key) header.i=@d1.example;",
    "    dmarc=pass",
    "Received: by 10.157.14.6 with HTTP; Tue, 3 Jan 2017 12:22:54 -0800 (PST)",
    "Message-ID: <54B84785.1060301@d1.example.org>",
    "Date: Thu, 14 Jan 2015 15:00:01 -0800",
    "From: John Q Doe <jqd@d1.example.org>",
    "To: arc@dmarc.org",
    "Subject: Example 1",
    "",
    "Hey gang,",
    "This is a test message.",
    "--J.",
    "",
  ].join("\r\n")

  const vectorKey =
    "v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDkHlOQoBTzWRiGs5V6NpP3id" +
    "Y6Wk08a5qhdR6wy5bdOKb2jLQiY/J16JYi0Qvx/byYzCNb3W91y3FutACDfzwQ/BC/e/8uBsCR+yz1Lx" +
    "j+PL6lHvqMKrM3rG4hstT5QjvHO9PzoxZyVYLzBfO2EeC3Ip3G+2kryOTIKT+l/K4w3QIDAQAB"
  const vectorLookup = async (d: string, s: string) =>
    d === "example.org" && s === "dummy" ? vectorKey : null

  test("passes", async () => {
    const chain = await verifyChain(vector, undefined, { lookup: vectorLookup })
    expect(chain).toMatchObject({ result: "pass", instance: 2, sealer: "example.org" })
  })

  test("fails once its body is touched", async () => {
    const touched = vector.replace("a test message", "a test  message!")
    expect((await verifyChain(touched, undefined, { lookup: vectorLookup })).result).toBe("fail")
  })
})

describe("the DMARC override", () => {
  const passed = { result: "pass" as const, sealer: "google.com" }

  test("applies only to a listed sealer, or a subdomain of one", () => {
    expect(dmarcOverride("fail", passed, ["google.com"])).toBe("google.com")
    expect(dmarcOverride("fail", { ...passed, sealer: "arc.google.com" }, ["google.com"])).toBe(
      "arc.google.com",
    )
    expect(dmarcOverride("fail", passed, [])).toBeNull()
    expect(dmarcOverride("fail", passed, ["outlook.com"])).toBeNull()
    // A suffix that is not a label boundary is a different domain.
    expect(dmarcOverride("fail", { ...passed, sealer: "evilgoogle.com" }, ["google.com"])).toBe(
      null,
    )
  })

  test("needs DMARC to have failed and ARC to have passed", () => {
    expect(dmarcOverride("pass", passed, ["google.com"])).toBeNull()
    expect(dmarcOverride("none", passed, ["google.com"])).toBeNull()
    expect(dmarcOverride("fail", { result: "fail", sealer: "google.com" }, ["google.com"])).toBe(
      null,
    )
  })

  test("cancels the DMARC penalty in the spam score, and nothing else", () => {
    const signals = {
      spf: "pass",
      dkim: "fail",
      dmarc: "fail",
      helo: "mail.far.invalid",
      remoteIp: "203.0.113.9",
      mailFrom: "alice@far.invalid",
      reverseDns: "mail.far.invalid",
    }
    const plain = score(RAW, signals)
    const overridden = score(RAW, { ...signals, dmarcOverride: "google.com" })
    expect(plain.score - overridden.score).toBe(4)
    expect(overridden.reasons.join("\n")).toContain("ARC sealed by google.com")
    expect(overridden.reasons.join("\n")).toContain("DKIM signature did not verify")
  })
})

// forwarding, against Postgres

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `arc-${suffix}.invalid`
const zoneKey = generateKeyPair()
let userId = ""
let domainId = ""

const envelopeFor = (rcpt: string): Envelope => ({
  helo: "far.invalid",
  mailFrom: "alice@far.invalid",
  hasSender: true,
  rcptTo: [rcpt],
  size: null,
  smtputf8: false,
})

const ctx = { remoteIp: "203.0.113.9", helo: "far.invalid" }

const queuedFor = async (rcpt: string): Promise<string> => {
  const row = await db().one<{ storage_key: string }>({
    text: "SELECT storage_key FROM deliveries WHERE rcpt_to = $1 ORDER BY created_at DESC LIMIT 1",
    values: [rcpt],
  })
  return inlineBody(row?.storage_key ?? "") ?? ""
}

const zoneLookup = async (d: string, s: string) =>
  d === zone && s === "corsair-1" ? dkimRecord(zoneKey.publicKey) : null

beforeAll(async () => {
  userId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Arc', $2) RETURNING id`,
    values: [`arc-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id
  domainId = (await db().one<{ id: string }>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=arc', 'active') RETURNING id`,
    values: [userId, zone],
  }))!.id
  await db().execute({
    text: `INSERT INTO dkim_keys (domain_id, selector, cname_target, private_key, public_key, active)
           VALUES ($1, 'corsair-1', 'dkim-1.corsair.local', $2, $3, true)`,
    values: [domainId, zoneKey.privateKey, zoneKey.publicKey],
  })
})

afterAll(async () => {
  await db().execute({ text: "DELETE FROM deliveries WHERE domain_id = $1", values: [domainId] })
  await db().execute(
    from(users)
      .where((q) => q("id").equals(userId))
      .del(),
  )
})

describe("mail this server forwards", () => {
  test("an alias forward carries a seal from the forwarding domain's key", async () => {
    await createAddress({
      domainId,
      localPart: "fwd",
      type: "alias",
      destinations: [`fwd-${suffix}@elsewhere.invalid`],
    })
    const reply = await handleMessage(envelopeFor(`fwd@${zone}`), RAW, ctx)
    expect(reply.code).toBe(250)

    const queued = await queuedFor(`fwd-${suffix}@elsewhere.invalid`)
    expect(queued).toStartWith("ARC-Seal: i=1;")
    const chain = await verifyChain(queued, undefined, { lookup: zoneLookup })
    expect(chain).toMatchObject({ result: "pass", instance: 1, sealer: zone })

    // The AAR is our Authentication-Results, numbered.
    const aar = queued.match(/^ARC-Authentication-Results: (.*(?:\r\n[ \t].*)*)/m)?.[1] ?? ""
    expect(aar.replace(/\r\n[ \t]+/g, " ")).toMatch(/^i=1; \S+; spf=\S+ .*arc=none$/)
  })

  test("a group seals once for every recipient", async () => {
    const team = [`t1-${suffix}@elsewhere.invalid`, `t2-${suffix}@elsewhere.invalid`]
    await createAddress({ domainId, localPart: "team", type: "group", destinations: team })
    await handleMessage(envelopeFor(`team@${zone}`), RAW, ctx)
    for (const rcpt of team) {
      const chain = await verifyChain(await queuedFor(rcpt), undefined, { lookup: zoneLookup })
      expect(chain.result).toBe("pass")
    }
  })

  test("a Sieve redirect carries a seal", async () => {
    const target = `redir-${suffix}@elsewhere.invalid`
    const filter = await db().one<{ id: string }>(
      from(filters)
        .insert({
          user_id: userId,
          name: `arc-${suffix}`,
          script: `redirect "${target}";`,
          size: 40,
        })
        .returning("id"),
    )
    await createAddress({
      domainId,
      localPart: "sieved",
      type: "standard",
      password: "hunter2hunter2",
      filterId: filter!.id,
    })
    await handleMessage(envelopeFor(`sieved@${zone}`), RAW, ctx)
    const chain = await verifyChain(await queuedFor(target), undefined, { lookup: zoneLookup })
    expect(chain).toMatchObject({ result: "pass", sealer: zone })
  })
})
