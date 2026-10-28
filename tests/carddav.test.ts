import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createAddress } from "../src/addresses/index.ts"
import { buildFetch } from "../src/api/index.ts"
import {
  CARDDAV,
  CS,
  child,
  children,
  DAV,
  el,
  parseXml,
  serializeXml,
  type XmlNode,
} from "../src/carddav/xml/index.ts"
import { editVcard, parseVcard } from "../src/contacts/index.ts"
import { db } from "../src/db/index.ts"

/**
 * CardDAV, end to end through `buildFetch` — the same path a phone's request
 * takes, so `checkOrigin`, the router ordering, and the Basic-auth funnel are all
 * in the loop. The discovery tests replay the requests iOS/macOS and DAVx5 make,
 * in their order.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const zone = `dav-${suffix}.invalid`
const password = "correct horse battery staple"
const otherPassword = "another horse battery staple"
const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`
const app = buildFetch(null)

let userId = ""
let addressId = ""
let otherId = ""
const me = `box@${zone}`
const them = `other@${zone}`

const basic = (user: string, pass: string) =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`

const dav = (
  method: string,
  path: string,
  init: { body?: string; headers?: Record<string, string>; as?: [string, string] | null } = {},
) => {
  const [user, pass] = init.as === undefined ? [me, password] : (init.as ?? ["", ""])
  const req = new Request(`http://corsair.test${path}`, {
    method,
    body: init.body,
    headers: {
      ...(init.as === null ? {} : { authorization: basic(user, pass) }),
      ...(init.body && !init.headers?.["content-type"]
        ? { "content-type": "application/xml; charset=utf-8" }
        : {}),
      ...init.headers,
    },
  })
  ;(req as { peerIp?: string }).peerIp = ip
  return app(req)
}

const xmlOf = async (res: Response): Promise<XmlNode> => parseXml(await res.text())

const responses = (doc: XmlNode) => children(doc, DAV, "response")

const hrefOf = (response: XmlNode) => child(response, DAV, "href")?.text ?? ""

/** The value of a property that came back 200, or undefined. */
const prop = (response: XmlNode, ns: string, name: string): XmlNode | undefined => {
  for (const ps of children(response, DAV, "propstat")) {
    if (!child(ps, DAV, "status")?.text.includes(" 200 ")) continue
    const found = child(child(ps, DAV, "prop"), ns, name)
    if (found) return found
  }
  return undefined
}

const propfindBody = (...props: [string, string][]) =>
  serializeXml(el(DAV, "propfind", el(DAV, "prop", ...props.map(([ns, name]) => el(ns, name)))))

const card = (uid: string, name: string, email: string) =>
  [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `UID:${uid}`,
    `FN:${name}`,
    `N:${name};;;;`,
    `EMAIL;TYPE=INTERNET:${email}`,
    "TEL:+1 555 0100",
    "END:VCARD",
    "",
  ].join("\r\n")

const bookPath = () => `/dav/addressbooks/${addressId}/default/`

const syncBody = (token: string) =>
  serializeXml(
    el(
      DAV,
      "sync-collection",
      el(DAV, "sync-token", token),
      el(DAV, "sync-level", "1"),
      el(DAV, "prop", el(DAV, "getetag")),
    ),
  )

beforeAll(async () => {
  userId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Dav', $2) RETURNING id`,
    values: [`dav-${suffix}@corsair.test`, Math.random().toString(36).slice(2, 12)],
  }))!.id
  const domain = (await db().one<{ id: string }>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=dav', 'active') RETURNING id`,
    values: [userId, zone],
  }))!
  addressId = (
    await createAddress({ domainId: domain.id, localPart: "box", type: "standard", password })
  ).address.id
  otherId = (
    await createAddress({
      domainId: domain.id,
      localPart: "other",
      type: "standard",
      password: otherPassword,
    })
  ).address.id
})

afterAll(async () => {
  await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [userId] })
  await db().execute({ text: "DELETE FROM auth_failures WHERE ip = $1", values: [ip] })
  await db().execute({ text: "DELETE FROM bans WHERE ip = $1", values: [ip] })
})

describe("the XML layer", () => {
  test("resolves namespaces, not prefixes", () => {
    const a = parseXml(`<D:propfind xmlns:D="DAV:"><D:prop><D:getetag/></D:prop></D:propfind>`)
    const b = parseXml(`<propfind xmlns="DAV:"><prop><getetag/></prop></propfind>`)
    for (const doc of [a, b]) {
      expect(doc.ns).toBe(DAV)
      expect(doc.name).toBe("propfind")
      expect(child(child(doc, DAV, "prop"), DAV, "getetag")).toBeDefined()
    }
  })

  test("scopes a redeclared prefix to its element", () => {
    const doc = parseXml(`<x:a xmlns:x="DAV:"><x:b xmlns:x="${CARDDAV}"><x:c/></x:b><x:d/></x:a>`)
    expect(doc.children[0]).toMatchObject({ ns: CARDDAV, name: "b" })
    expect(doc.children[0]!.children[0]).toMatchObject({ ns: CARDDAV, name: "c" })
    expect(doc.children[1]).toMatchObject({ ns: DAV, name: "d" })
  })

  test("decodes the predefined entities and character references", () => {
    const doc = parseXml(`<a xmlns="DAV:">x &amp; &lt;y&gt; &#65;&#x42; <![CDATA[<raw>]]></a>`)
    expect(doc.text).toBe("x & <y> AB <raw>")
  })

  test("refuses a DOCTYPE outright, so no entity can be declared", () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><a>&lol2;</a>`
    expect(() => parseXml(bomb)).toThrow(/DOCTYPE/)
    expect(() => parseXml(`<a>&xxe;</a>`)).toThrow(/unknown entity/)
  })

  test("refuses malformed documents", () => {
    expect(() => parseXml(`<a><b></a></b>`)).toThrow()
    expect(() => parseXml(`<a>`)).toThrow()
    expect(() => parseXml(`<p:a/>`)).toThrow(/undeclared prefix/)
    expect(() => parseXml(`<a/><b/>`)).toThrow()
    expect(() => parseXml(`${"<a>".repeat(100)}${"</a>".repeat(100)}`)).toThrow(/deeply/)
  })

  test("serialises with every namespace declared, unknown ones included, and escapes text", () => {
    const out = serializeXml(
      el(DAV, "prop", el(CS, "getctag", "a<&>b"), el("urn:x-unknown", "thing")),
    )
    const back = parseXml(out)
    expect(child(back, CS, "getctag")?.text).toBe("a<&>b")
    expect(child(back, "urn:x-unknown", "thing")).toBeDefined()
    expect(out).toContain('xmlns:d="DAV:"')
  })
})

describe("vCard handling", () => {
  test("unfolds and unescapes", () => {
    const parsed = parseVcard(
      "BEGIN:VCARD\r\nVERSION:4.0\r\nUID:u1\r\nFN:Ada\\, Countess\r\n  of Lovelace\r\nEMAIL;TYPE=work:ada@example.com\r\nEND:VCARD\r\n",
    )
    expect(parsed.fullName).toBe("Ada, Countess of Lovelace")
    expect(parsed.emails).toEqual(["ada@example.com"])
  })

  test("refuses what is not one vCard 3.0 or 4.0", () => {
    expect(() => parseVcard("hello")).toThrow()
    expect(() => parseVcard("BEGIN:VCARD\r\nVERSION:2.1\r\nFN:x\r\nEND:VCARD\r\n")).toThrow(
      /VERSION/,
    )
    expect(() =>
      parseVcard("BEGIN:VCARD\r\nVERSION:3.0\r\nBEGIN:VCARD\r\nEND:VCARD\r\nEND:VCARD\r\n"),
    ).toThrow(/more than one/)
  })

  test("an edit from the webmail keeps the fields it does not own", () => {
    const edited = editVcard(card("u2", "Old Name", "old@example.com"), {
      name: "New Name",
      emails: ["new@example.com"],
    })
    const parsed = parseVcard(edited)
    expect(parsed.fullName).toBe("New Name")
    expect(parsed.emails).toEqual(["new@example.com"])
    expect(parsed.uid).toBe("u2")
    expect(edited).toContain("TEL:+1 555 0100")
  })
})

describe("discovery", () => {
  test("OPTIONS advertises addressbook without credentials", async () => {
    const res = await dav("OPTIONS", "/dav/", { as: null })
    expect(res.status).toBe(200)
    expect(res.headers.get("dav")).toContain("addressbook")
    expect(res.headers.get("allow")).toContain("REPORT")
  })

  test("the iOS / macOS chain: well-known → principal → home → book", async () => {
    const wellKnown = await dav("PROPFIND", "/.well-known/carddav", {
      body: propfindBody([DAV, "current-user-principal"]),
      headers: { depth: "0" },
    })
    expect(wellKnown.status).toBe(301)
    const context = wellKnown.headers.get("location")!
    expect(context).toBe("/dav/")

    const root = await xmlOf(
      await dav("PROPFIND", context, {
        body: propfindBody([DAV, "current-user-principal"], [DAV, "resourcetype"]),
        headers: { depth: "0" },
      }),
    )
    const principal = child(
      prop(responses(root)[0]!, DAV, "current-user-principal"),
      DAV,
      "href",
    )!.text
    expect(principal).toBe(`/dav/principals/${addressId}/`)

    const principalDoc = await xmlOf(
      await dav("PROPFIND", principal, {
        body: propfindBody(
          [CARDDAV, "addressbook-home-set"],
          [DAV, "displayname"],
          [CS, "email-address-set"],
        ),
        headers: { depth: "0" },
      }),
    )
    const first = responses(principalDoc)[0]!
    const home = child(prop(first, CARDDAV, "addressbook-home-set"), DAV, "href")!.text
    expect(home).toBe(`/dav/addressbooks/${addressId}/`)
    expect(child(prop(first, CS, "email-address-set"), CS, "email-address")?.text).toBe(me)

    const homeRes = await dav("PROPFIND", home, {
      body: propfindBody(
        [DAV, "resourcetype"],
        [DAV, "displayname"],
        [CS, "getctag"],
        [DAV, "current-user-privilege-set"],
      ),
      headers: { depth: "1" },
    })
    expect(homeRes.status).toBe(207)
    const homeDoc = await xmlOf(homeRes)
    const book = responses(homeDoc).find((r) =>
      child(prop(r, DAV, "resourcetype"), CARDDAV, "addressbook"),
    )
    expect(book).toBeDefined()
    expect(hrefOf(book!)).toBe(bookPath())
    expect(prop(book!, CS, "getctag")?.text).toMatch(/^urn:corsair:sync:/)
    const privs = children(prop(book!, DAV, "current-user-privilege-set"), DAV, "privilege").map(
      (p) => p.children[0]?.name,
    )
    expect(privs).toContain("bind")
  })

  test("the DAVx5 chain: PROPFIND on the book for reports and the sync token", async () => {
    const res = await dav("PROPFIND", bookPath(), {
      body: propfindBody(
        [DAV, "supported-report-set"],
        [DAV, "sync-token"],
        [CARDDAV, "supported-address-data"],
        [CARDDAV, "addressbook-description"],
      ),
      headers: { depth: "0" },
    })
    const doc = await xmlOf(res)
    const response = responses(doc)[0]!
    const reports = children(
      prop(response, DAV, "supported-report-set"),
      DAV,
      "supported-report",
    ).map((r) => child(r, DAV, "report")?.children[0]?.name)
    expect(reports).toEqual(["addressbook-multiget", "addressbook-query", "sync-collection"])
    expect(prop(response, DAV, "sync-token")?.text).toMatch(/^urn:corsair:sync:/)
    // Unsupported properties come back under a 404, not as an error.
    const missing = children(response, DAV, "propstat").find((ps) =>
      child(ps, DAV, "status")?.text.includes("404"),
    )
    expect(child(child(missing, DAV, "prop"), CARDDAV, "addressbook-description")).toBeDefined()
  })

  test("an empty PROPFIND body is allprop", async () => {
    const res = await dav("PROPFIND", bookPath(), { headers: { depth: "0" } })
    expect(res.status).toBe(207)
    expect(prop(responses(await xmlOf(res))[0]!, DAV, "displayname")?.text).toBe("Contacts")
  })

  test("a DOCTYPE in a request body is a 400", async () => {
    const res = await dav("PROPFIND", "/dav/", {
      body: `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><propfind xmlns="DAV:"><allprop/></propfind>`,
    })
    expect(res.status).toBe(400)
  })

  test("MKCOL is refused: one book per mailbox", async () => {
    expect((await dav("MKCOL", `/dav/addressbooks/${addressId}/second/`)).status).toBe(403)
  })
})

describe("authentication", () => {
  test("no credentials is a 401 with a Basic challenge", async () => {
    const res = await dav("PROPFIND", "/dav/", { as: null })
    expect(res.status).toBe(401)
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic /)
  })

  test("a wrong password is a 401 and is recorded against the IP", async () => {
    const res = await dav("PROPFIND", "/dav/", { as: [me, "wrong password"] })
    expect(res.status).toBe(401)
    const row = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM auth_failures WHERE ip = $1 AND protocol = 'carddav' AND username = $2",
      values: [ip, me],
    })
    expect(Number(row?.count)).toBe(1)
  })

  test("a panel session cookie is not a DAV credential", async () => {
    const res = await dav("PROPFIND", "/dav/", {
      as: null,
      headers: { cookie: "corsair_webmail=x; corsair_session=y" },
    })
    expect(res.status).toBe(401)
  })
})

describe("contacts over CardDAV", () => {
  let etag = ""
  const path = () => `${bookPath()}alice.vcf`

  test("PUT with If-None-Match: * creates, and a second one is refused", async () => {
    const res = await dav("PUT", path(), {
      body: card("alice-uid", "Alice Example", "alice@example.com"),
      headers: { "content-type": "text/vcard; charset=utf-8", "if-none-match": "*" },
    })
    expect(res.status).toBe(201)
    etag = res.headers.get("etag")!
    expect(etag).toMatch(/^".+"$/)

    const again = await dav("PUT", path(), {
      body: card("alice-uid", "Alice Example", "alice@example.com"),
      headers: { "content-type": "text/vcard", "if-none-match": "*" },
    })
    expect(again.status).toBe(412)
  })

  test("GET returns the card byte for byte, with its ETag", async () => {
    const res = await dav("GET", path())
    expect(res.status).toBe(200)
    expect(res.headers.get("etag")).toBe(etag)
    expect(res.headers.get("content-type")).toContain("text/vcard")
    expect(await res.text()).toBe(card("alice-uid", "Alice Example", "alice@example.com"))
  })

  test("If-Match with a stale ETag is a 412 and changes nothing; the right one wins", async () => {
    const stale = await dav("PUT", path(), {
      body: card("alice-uid", "Alice Changed", "alice@example.com"),
      headers: { "content-type": "text/vcard", "if-match": '"not-the-etag"' },
    })
    expect(stale.status).toBe(412)

    const ok = await dav("PUT", path(), {
      body: card("alice-uid", "Alice Changed", "alice@example.com"),
      headers: { "content-type": "text/vcard", "if-match": etag },
    })
    expect(ok.status).toBe(204)
    const next = ok.headers.get("etag")!
    expect(next).not.toBe(etag)
    etag = next
  })

  test("a second card with the same UID is a no-uid-conflict", async () => {
    const res = await dav("PUT", `${bookPath()}alice-copy.vcf`, {
      body: card("alice-uid", "Alice Copy", "copy@example.com"),
      headers: { "content-type": "text/vcard" },
    })
    expect(res.status).toBe(403)
    expect(child(await xmlOf(res), CARDDAV, "no-uid-conflict")).toBeDefined()
  })

  test("a body that is not a vCard is refused", async () => {
    const res = await dav("PUT", `${bookPath()}junk.vcf`, {
      body: "BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n",
      headers: { "content-type": "text/vcard" },
    })
    expect(res.status).toBe(403)
    expect(child(await xmlOf(res), CARDDAV, "valid-address-data")).toBeDefined()
  })

  test("a card over the size cap is refused", async () => {
    const big = card("big", "Big", "big@example.com").replace(
      "TEL:",
      `NOTE:${"x".repeat(300 * 1024)}\r\nTEL:`,
    )
    const res = await dav("PUT", `${bookPath()}big.vcf`, {
      body: big,
      headers: { "content-type": "text/vcard" },
    })
    expect(res.status).toBe(403)
  })

  test("PROPFIND depth 1 on the book lists the card with its ETag", async () => {
    const doc = await xmlOf(
      await dav("PROPFIND", bookPath(), {
        body: propfindBody([DAV, "getetag"]),
        headers: { depth: "1" },
      }),
    )
    const entry = responses(doc).find((r) => hrefOf(r) === path())
    expect(prop(entry!, DAV, "getetag")?.text).toBe(etag)
  })

  test("addressbook-multiget returns the card and a 404 for an unknown href", async () => {
    const body = serializeXml(
      el(
        CARDDAV,
        "addressbook-multiget",
        el(DAV, "prop", el(DAV, "getetag"), el(CARDDAV, "address-data")),
        el(DAV, "href", path()),
        el(DAV, "href", `${bookPath()}nobody.vcf`),
      ),
    )
    const doc = await xmlOf(await dav("REPORT", bookPath(), { body, headers: { depth: "1" } }))
    const [found, missing] = responses(doc)
    expect(prop(found!, CARDDAV, "address-data")?.text).toContain("FN:Alice Changed")
    expect(child(missing!, DAV, "status")?.text).toContain("404")
  })

  test("addressbook-query filters on EMAIL, and returns everything without a filter", async () => {
    await dav("PUT", `${bookPath()}bob.vcf`, {
      body: card("bob-uid", "Bob Example", "bob@example.org"),
      headers: { "content-type": "text/vcard" },
    })
    const filtered = serializeXml(
      el(
        CARDDAV,
        "addressbook-query",
        el(DAV, "prop", el(DAV, "getetag")),
        el(CARDDAV, "filter", {
          ns: CARDDAV,
          name: "prop-filter",
          attrs: { name: "EMAIL" },
          children: [
            {
              ns: CARDDAV,
              name: "text-match",
              attrs: { "match-type": "contains" },
              children: ["EXAMPLE.ORG"],
            },
          ],
        }),
      ),
    )
    const hits = responses(
      await xmlOf(await dav("REPORT", bookPath(), { body: filtered, headers: { depth: "1" } })),
    )
    expect(hits.map(hrefOf)).toEqual([`${bookPath()}bob.vcf`])

    const all = serializeXml(el(CARDDAV, "addressbook-query", el(DAV, "prop", el(DAV, "getetag"))))
    const everything = responses(
      await xmlOf(await dav("REPORT", bookPath(), { body: all, headers: { depth: "1" } })),
    )
    expect(everything.map(hrefOf).sort()).toEqual([path(), `${bookPath()}bob.vcf`].sort())
  })

  test("DELETE honours If-Match, then removes the card", async () => {
    expect((await dav("DELETE", path(), { headers: { "if-match": '"stale"' } })).status).toBe(412)
    expect((await dav("DELETE", path(), { headers: { "if-match": etag } })).status).toBe(204)
    expect((await dav("GET", path())).status).toBe(404)
    expect((await dav("DELETE", path())).status).toBe(404)
  })
})

describe("sync-collection", () => {
  test("returns changes and deletions since a token, and a fresh token", async () => {
    const initial = await xmlOf(await dav("REPORT", bookPath(), { body: syncBody("") }))
    const t0 = child(initial, DAV, "sync-token")!.text
    // An initial sync lists live cards only, never tombstones.
    expect(responses(initial).every((r) => prop(r, DAV, "getetag"))).toBe(true)

    await dav("PUT", `${bookPath()}carol.vcf`, {
      body: card("carol-uid", "Carol", "carol@example.com"),
      headers: { "content-type": "text/vcard" },
    })
    await dav("DELETE", `${bookPath()}bob.vcf`)

    const delta = await xmlOf(await dav("REPORT", bookPath(), { body: syncBody(t0) }))
    const t1 = child(delta, DAV, "sync-token")!.text
    expect(t1).not.toBe(t0)
    const byHref = new Map(responses(delta).map((r) => [hrefOf(r), r]))
    expect(prop(byHref.get(`${bookPath()}carol.vcf`)!, DAV, "getetag")).toBeDefined()
    expect(child(byHref.get(`${bookPath()}bob.vcf`)!, DAV, "status")?.text).toContain("404")
    expect(byHref.size).toBe(2)

    const quiet = await xmlOf(await dav("REPORT", bookPath(), { body: syncBody(t1) }))
    expect(responses(quiet)).toHaveLength(0)
    expect(child(quiet, DAV, "sync-token")!.text).toBe(t1)
  })

  test("a token that is not this book's is refused with valid-sync-token", async () => {
    for (const token of [
      "urn:corsair:sync:nope",
      `urn:corsair:sync:${addressId}:1`,
      "http://example.com/x",
    ]) {
      const res = await dav("REPORT", bookPath(), { body: syncBody(token) })
      expect(res.status).toBe(403)
      expect(child(await xmlOf(res), DAV, "valid-sync-token")).toBeDefined()
    }
  })
})

describe("isolation", () => {
  test("another mailbox's principal, home, book, and cards are 404", async () => {
    await dav("PUT", `/dav/addressbooks/${otherId}/default/secret.vcf`, {
      as: [them, otherPassword],
      body: card("secret-uid", "Secret", "secret@example.com"),
      headers: { "content-type": "text/vcard" },
    })
    for (const path of [
      `/dav/principals/${otherId}/`,
      `/dav/addressbooks/${otherId}/`,
      `/dav/addressbooks/${otherId}/default/`,
      `/dav/addressbooks/${otherId}/default/secret.vcf`,
    ]) {
      expect((await dav("PROPFIND", path, { headers: { depth: "0" } })).status).toBe(404)
    }
    expect((await dav("GET", `/dav/addressbooks/${otherId}/default/secret.vcf`)).status).toBe(404)
    expect((await dav("DELETE", `/dav/addressbooks/${otherId}/default/secret.vcf`)).status).toBe(
      404,
    )

    // Naming their card in a multiget on your own book finds nothing.
    const body = serializeXml(
      el(
        CARDDAV,
        "addressbook-multiget",
        el(DAV, "prop", el(CARDDAV, "address-data")),
        el(DAV, "href", `/dav/addressbooks/${otherId}/default/secret.vcf`),
      ),
    )
    const doc = await xmlOf(await dav("REPORT", bookPath(), { body }))
    expect(child(responses(doc)[0]!, DAV, "status")?.text).toContain("404")

    // And theirs is intact.
    expect(
      (
        await dav("GET", `/dav/addressbooks/${otherId}/default/secret.vcf`, {
          as: [them, otherPassword],
        })
      ).status,
    ).toBe(200)
  })

  test("a cross-site browser write is refused before auth; a DAV client with no Origin is not", async () => {
    const res = await dav("PUT", `${bookPath()}evil.vcf`, {
      body: card("evil", "Evil", "evil@example.com"),
      headers: { "content-type": "text/vcard", origin: "https://evil.example" },
    })
    expect(res.status).toBe(403)
    expect((await dav("GET", `${bookPath()}evil.vcf`)).status).toBe(404)
  })
})

describe("the webmail's contacts", () => {
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) => {
    const { cookie, ...rest } = init
    const req = new Request(`http://corsair.test${path}`, {
      ...rest,
      headers: {
        "content-type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...rest.headers,
      },
    })
    ;(req as { peerIp?: string }).peerIp = ip
    return app(req)
  }

  const login = async (email: string, pass: string) => {
    await Bun.sleep(300)
    const res = await call("/api/mail/login", {
      method: "POST",
      body: JSON.stringify({ email, password: pass }),
    })
    expect(res.status).toBe(200)
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!
  }

  test("autocomplete finds a card written over CardDAV, by name or address, and only your own", async () => {
    const cookie = await login(me, password)
    const byName = await (await call("/api/mail/contacts?q=caro", { cookie })).json()
    expect(byName.data.map((c: { name: string }) => c.name)).toEqual(["Carol"])
    const byEmail = await (await call("/api/mail/contacts?q=carol%40example", { cookie })).json()
    expect(byEmail.data[0].emails).toEqual(["carol@example.com"])
    // A LIKE wildcard in the query is a literal.
    expect((await (await call("/api/mail/contacts?q=%25", { cookie })).json()).data).toHaveLength(0)
    expect(
      (await (await call("/api/mail/contacts?q=secret", { cookie })).json()).data,
    ).toHaveLength(0)
  })

  test("create, edit, and delete show up over CardDAV", async () => {
    const cookie = await login(me, password)
    const created = await call("/api/mail/contacts", {
      method: "POST",
      cookie,
      body: JSON.stringify({ name: "Dana Web", emails: ["dana@example.com"] }),
    })
    expect(created.status).toBe(201)
    const contact = await created.json()

    const before = await xmlOf(await dav("REPORT", bookPath(), { body: syncBody("") }))
    const t = child(before, DAV, "sync-token")!.text

    const edited = await call(`/api/mail/contacts/${contact.id}`, {
      method: "PATCH",
      cookie,
      body: JSON.stringify({ name: "Dana Edited", emails: ["dana@example.net"] }),
    })
    expect(edited.status).toBe(200)

    const delta = await xmlOf(await dav("REPORT", bookPath(), { body: syncBody(t) }))
    expect(responses(delta)).toHaveLength(1)
    const href = hrefOf(responses(delta)[0]!)
    expect(await (await dav("GET", href)).text()).toContain("FN:Dana Edited")

    // The other mailbox cannot touch it.
    const otherCookie = await login(them, otherPassword)
    expect(
      (await call(`/api/mail/contacts/${contact.id}`, { method: "DELETE", cookie: otherCookie }))
        .status,
    ).toBe(404)

    expect(
      (await call(`/api/mail/contacts/${contact.id}`, { method: "DELETE", cookie })).status,
    ).toBe(200)
    expect((await dav("GET", href)).status).toBe(404)
  })
})
