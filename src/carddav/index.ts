import { ipOf } from "../api/pipes/index.ts"
import {
  authenticateAddress,
  isBanned,
  type MailIdentity,
  recordAuthFailure,
} from "../auth/index.ts"
import {
  bookToken,
  changesSince,
  contactByHref,
  contactsAllowed,
  DEFAULT_BOOK,
  defaultBook,
  deleteContact,
  isVcardError,
  liveContacts,
  MAX_VCARD_BYTES,
  type Precondition,
  parseVcard,
  putContact,
  unescapeValue,
  type Vcard,
  validHref,
  type WriteResult,
} from "../contacts/index.ts"
import { db, num } from "../db/index.ts"
import type { AddressBook, Contact } from "../schema/index.ts"
import {
  CARDDAV,
  CS,
  child,
  children,
  DAV,
  el,
  is,
  isXmlError,
  parseXml,
  serializeXml,
  type XmlNode,
  type XmlOut,
} from "./xml/index.ts"

/**
 * CardDAV — RFC 6352 over WebDAV (RFC 4918), with RFC 6578 sync.
 *
 * Contacts only. CalDAV is a deliberate omission: contacts are what powers
 * recipient autocomplete and what people expect to follow them between devices,
 * while calendars are a large, quirky surface for a mail server to take on.
 *
 * Handled ahead of the Atlas router, because the router knows nothing of
 * PROPFIND or REPORT and would hand an XML body to a JSON parser. It still runs
 * inside `buildFetch`, so the security headers and `checkOrigin` apply: a DAV
 * client sends no Origin and passes; a browser on another site trying a PUT or
 * DELETE does send one and is refused.
 *
 * Authentication is HTTP Basic, through `authenticateAddress` like every other
 * mail protocol — the failure ban, the verify gate, and the agent and linked
 * account rules all come with it. Never a cookie: a cookie would make every
 * DAV write a cross-site request forgery away from happening.
 *
 * Layout, one book per mailbox:
 *
 *   /dav/                                      context path (RFC 6764)
 *   /dav/principals/<address id>/              the principal
 *   /dav/addressbooks/<address id>/            addressbook-home-set
 *   /dav/addressbooks/<address id>/default/    the book
 *   /dav/addressbooks/<address id>/default/<name>.vcf
 */

const ROOT = "/dav/"
const MAX_XML_BYTES = 1024 * 1024
const REALM = 'Basic realm="Corsair Contacts", charset="UTF-8"'
const ALLOW = "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT"

const principalPath = (id: string) => `/dav/principals/${id}/`
const homePath = (id: string) => `/dav/addressbooks/${id}/`
const bookPath = (book: AddressBook) => `/dav/addressbooks/${book.address_id}/${book.slug}/`

/** Percent-encodes everything that is not a path character (RFC 3986 `pchar`). */
const encodeSegment = (segment: string): string =>
  Array.from(new TextEncoder().encode(segment))
    .map((byte) => {
      const ch = String.fromCharCode(byte)
      return /[A-Za-z0-9\-._~!$&'()*+,;=:@]/.test(ch) && byte < 0x80
        ? ch
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")

const contactPath = (book: AddressBook, contact: Contact) =>
  `${bookPath(book)}${encodeSegment(contact.href)}`

const tokenOf = (book: AddressBook, value: number) => `urn:corsair:sync:${book.id}:${value}`

// responses

const XML_TYPE = "application/xml; charset=utf-8"

const reply = (status: number, body: string | null = null, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...(body !== null ? { "content-type": "text/plain; charset=utf-8" } : {}),
      ...headers,
    },
  })

const xmlReply = (status: number, root: XmlOut, headers: Record<string, string> = {}) =>
  reply(status, serializeXml(root), { "content-type": XML_TYPE, ...headers })

/** A failed precondition named in the body, which is how WebDAV says *which* one. */
const conditionFailed = (status: number, ...condition: XmlOut[]) =>
  xmlReply(status, el(DAV, "error", ...condition))

const unauthorized = () => reply(401, "Authentication required.\n", { "www-authenticate": REALM })

const multistatus = (...responses: (XmlOut | null | false)[]) =>
  el(DAV, "multistatus", ...responses)

const statusLine = (code: number, text: string) => el(DAV, "status", `HTTP/1.1 ${code} ${text}`)

const propstat = (props: XmlOut[], code: number, text: string) =>
  el(DAV, "propstat", el(DAV, "prop", ...props), statusLine(code, text))

const hrefEl = (path: string) => el(DAV, "href", path)

// auth

const authenticate = async (req: Request): Promise<MailIdentity | Response> => {
  const header = req.headers.get("authorization")
  const basic = header?.match(/^Basic\s+([A-Za-z0-9+/=]+)\s*$/i)?.[1]
  if (!basic) return unauthorized()

  const decoded = Buffer.from(basic, "base64").toString("utf8")
  const colon = decoded.indexOf(":")
  if (colon === -1) return unauthorized()

  const ip = ipOf({ request: req } as never)
  if (await isBanned(ip, "carddav")) return unauthorized()

  const username = decoded.slice(0, colon)
  let identity: MailIdentity | null
  try {
    identity = await authenticateAddress(username, decoded.slice(colon + 1), ip, "dav")
  } catch (error) {
    // The verify gate is full. That is load, not a wrong password.
    if ((error as { statusCode?: number }).statusCode === 429) {
      return reply(503, "Busy; try again shortly.\n", { "retry-after": "5" })
    }
    throw error
  }
  if (!identity) {
    await recordAuthFailure(ip, "carddav", username).catch(() => {})
    return unauthorized()
  }
  if (!contactsAllowed(identity.address)) {
    return reply(403, "This mailbox has no address book.\n")
  }
  return identity
}

// resources

type Resource =
  | { kind: "root"; path: string }
  | { kind: "principal"; path: string }
  | { kind: "home"; path: string }
  | { kind: "book"; path: string; book: AddressBook }
  | { kind: "contact"; path: string; book: AddressBook; contact: Contact | null; href: string }

type Target = Resource | { kind: "missing" }

const segmentsOf = (pathname: string): string[] | null => {
  try {
    return pathname
      .split("/")
      .filter(Boolean)
      .map((s) => decodeURIComponent(s))
  } catch {
    return null
  }
}

/**
 * Maps a path to a resource of the signed-in mailbox. Another mailbox's id is
 * "missing" exactly as a nonexistent one is: nothing here confirms that an
 * address id exists unless it is yours.
 */
const resolve = async (identity: MailIdentity, pathname: string): Promise<Target> => {
  const segments = segmentsOf(pathname)
  if (!segments) return { kind: "missing" }
  if (segments.length === 0) return { kind: "root", path: "/" }
  if (segments[0] !== "dav") return { kind: "missing" }

  const own = identity.address.id
  const [, area, id, slug, name, ...extra] = segments
  if (!area) return { kind: "root", path: ROOT }
  if (id !== own || extra.length) return { kind: "missing" }

  if (area === "principals" && slug === undefined)
    return { kind: "principal", path: principalPath(own) }
  if (area !== "addressbooks") return { kind: "missing" }
  if (slug === undefined) return { kind: "home", path: homePath(own) }
  if (slug !== DEFAULT_BOOK) return { kind: "missing" }

  const book = await defaultBook(own)
  if (name === undefined) return { kind: "book", path: bookPath(book), book }
  if (!validHref(name)) return { kind: "missing" }
  const contact = await contactByHref(book.id, name)
  return {
    kind: "contact",
    path: `${bookPath(book)}${encodeSegment(name)}`,
    book,
    contact,
    href: name,
  }
}

// properties

type PropName = { ns: string; name: string }

const key = (p: PropName) => `${p.ns}|${p.name}`

const privileges = (...names: string[]) => names.map((name) => el(DAV, "privilege", el(DAV, name)))

const report = (ns: string, name: string) =>
  el(DAV, "supported-report", el(DAV, "report", el(ns, name)))

const httpDate = (value: Date) => value.toUTCString()

/**
 * Property values for one resource, keyed `ns|name`. A property absent from the
 * map comes back under a 404 propstat, which is how a client learns it is not
 * supported here.
 */
const propertiesOf = (identity: MailIdentity, resource: Resource, addressData: boolean) => {
  const own = identity.address.id
  const props = new Map<string, (XmlOut | string)[]>()
  const set = (ns: string, name: string, ...value: (XmlOut | string)[]) =>
    props.set(`${ns}|${name}`, value)

  set(DAV, "current-user-principal", hrefEl(principalPath(own)))

  switch (resource.kind) {
    case "root":
      set(DAV, "resourcetype", el(DAV, "collection"))
      set(DAV, "principal-collection-set", hrefEl("/dav/principals/"))
      set(CARDDAV, "addressbook-home-set", hrefEl(homePath(own)))
      set(
        DAV,
        "current-user-privilege-set",
        ...privileges("read", "read-current-user-privilege-set"),
      )
      break
    case "principal":
      set(DAV, "resourcetype", el(DAV, "principal"))
      set(DAV, "displayname", identity.address.name || identity.email)
      set(DAV, "principal-URL", hrefEl(principalPath(own)))
      set(DAV, "principal-collection-set", hrefEl("/dav/principals/"))
      set(CARDDAV, "addressbook-home-set", hrefEl(homePath(own)))
      set(CS, "email-address-set", el(CS, "email-address", identity.email))
      set(
        DAV,
        "current-user-privilege-set",
        ...privileges("read", "read-current-user-privilege-set"),
      )
      break
    case "home":
      set(DAV, "resourcetype", el(DAV, "collection"))
      set(DAV, "displayname", "Address books")
      set(DAV, "owner", hrefEl(principalPath(own)))
      set(
        DAV,
        "current-user-privilege-set",
        ...privileges("read", "read-current-user-privilege-set"),
      )
      break
    case "book": {
      const token = tokenOf(resource.book, num(resource.book.sync_token))
      set(DAV, "resourcetype", el(DAV, "collection"), el(CARDDAV, "addressbook"))
      set(DAV, "displayname", resource.book.name)
      set(DAV, "owner", hrefEl(principalPath(own)))
      set(DAV, "sync-token", token)
      set(CS, "getctag", token)
      set(
        DAV,
        "supported-report-set",
        report(CARDDAV, "addressbook-multiget"),
        report(CARDDAV, "addressbook-query"),
        report(DAV, "sync-collection"),
      )
      set(
        CARDDAV,
        "supported-address-data",
        {
          ns: CARDDAV,
          name: "address-data-type",
          attrs: { "content-type": "text/vcard", version: "3.0" },
        },
        {
          ns: CARDDAV,
          name: "address-data-type",
          attrs: { "content-type": "text/vcard", version: "4.0" },
        },
      )
      set(CARDDAV, "max-resource-size", String(MAX_VCARD_BYTES))
      set(
        DAV,
        "current-user-privilege-set",
        ...privileges(
          "read",
          "write",
          "write-properties",
          "write-content",
          "bind",
          "unbind",
          "read-current-user-privilege-set",
        ),
      )
      break
    }
    case "contact": {
      const contact = resource.contact as Contact
      set(DAV, "resourcetype")
      set(DAV, "getetag", `"${contact.etag}"`)
      set(DAV, "getcontenttype", "text/vcard; charset=utf-8")
      set(DAV, "getcontentlength", String(contact.size))
      set(DAV, "getlastmodified", httpDate(contact.updated_at))
      set(
        DAV,
        "current-user-privilege-set",
        ...privileges("read", "write", "write-content", "read-current-user-privilege-set"),
      )
      if (addressData) set(CARDDAV, "address-data", contact.vcard)
      break
    }
  }
  return props
}

/** What `allprop` returns: the cheap, standard properties, never address-data. */
const ALLPROP: PropName[] = [
  { ns: DAV, name: "resourcetype" },
  { ns: DAV, name: "displayname" },
  { ns: DAV, name: "getetag" },
  { ns: DAV, name: "getcontenttype" },
  { ns: DAV, name: "getcontentlength" },
  { ns: DAV, name: "getlastmodified" },
  { ns: DAV, name: "sync-token" },
  { ns: CS, name: "getctag" },
]

type PropRequest = { mode: "prop"; props: PropName[] } | { mode: "allprop" } | { mode: "propname" }

const propRequestOf = (root: XmlNode | null): PropRequest => {
  if (!root) return { mode: "allprop" }
  if (child(root, DAV, "propname")) return { mode: "propname" }
  const prop = child(root, DAV, "prop")
  if (prop) return { mode: "prop", props: prop.children.map((c) => ({ ns: c.ns, name: c.name })) }
  return { mode: "allprop" }
}

const responseFor = (identity: MailIdentity, resource: Resource, request: PropRequest): XmlOut => {
  const wantsData =
    request.mode === "prop" &&
    request.props.some((p) => p.ns === CARDDAV && p.name === "address-data")
  const values = propertiesOf(identity, resource, wantsData)

  if (request.mode === "propname") {
    const names = [...values.keys()].map((k) => {
      const [ns = "", name = ""] = k.split("|")
      return el(ns, name)
    })
    return el(DAV, "response", hrefEl(resource.path), propstat(names, 200, "OK"))
  }

  const wanted =
    request.mode === "allprop" ? ALLPROP.filter((p) => values.has(key(p))) : request.props
  const found: XmlOut[] = []
  const missing: XmlOut[] = []
  for (const p of wanted) {
    const value = values.get(key(p))
    if (value) found.push(el(p.ns, p.name, ...value))
    else missing.push(el(p.ns, p.name))
  }
  return el(
    DAV,
    "response",
    hrefEl(resource.path),
    found.length > 0 && propstat(found, 200, "OK"),
    missing.length > 0 && propstat(missing, 404, "Not Found"),
  )
}

// request bodies

/**
 * Reads at most `limit` bytes, and refuses anything larger without buffering it.
 * The server's own body limit is sized for 25 MB messages; no DAV body here is
 * anywhere near that.
 */
const readCapped = async (req: Request, limit: number): Promise<string | null> => {
  const declared = Number(req.headers.get("content-length") ?? "0")
  if (declared > limit) return null
  if (!req.body) return ""
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (total > limit) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
}

const readXml = async (req: Request): Promise<XmlNode | null | Response> => {
  let body: string | null
  try {
    body = await readCapped(req, MAX_XML_BYTES)
  } catch {
    return reply(400, "Request body is not UTF-8.\n")
  }
  if (body === null) return reply(413, "Request body too large.\n")
  if (!body.trim()) return null
  try {
    return parseXml(body)
  } catch (error) {
    if (isXmlError(error)) return reply(400, `${(error as Error).message}\n`)
    throw error
  }
}

// methods

const depthOf = (req: Request, fallback: "0" | "1"): "0" | "1" => {
  const depth = req.headers.get("depth")?.trim().toLowerCase()
  if (depth === "0") return "0"
  // "infinity" is answered as 1: nothing here nests deeper than a book.
  if (depth === "1" || depth === "infinity") return "1"
  return fallback
}

const propfind = async (req: Request, identity: MailIdentity, resource: Resource) => {
  const body = await readXml(req)
  if (body instanceof Response) return body
  if (body && !is(body, DAV, "propfind")) return reply(400, "Expected a DAV:propfind body.\n")
  if (resource.kind === "contact" && !resource.contact) return reply(404, "Not found.\n")

  const request = propRequestOf(body)
  const responses = [responseFor(identity, resource, request)]

  if (depthOf(req, "1") === "1") {
    if (resource.kind === "home") {
      const book = await defaultBook(identity.address.id)
      responses.push(responseFor(identity, { kind: "book", path: bookPath(book), book }, request))
    }
    if (resource.kind === "book") {
      for (const contact of await liveContacts(resource.book.id)) {
        responses.push(
          responseFor(
            identity,
            {
              kind: "contact",
              path: contactPath(resource.book, contact),
              book: resource.book,
              contact,
              href: contact.href,
            },
            request,
          ),
        )
      }
    }
  }
  return xmlReply(207, multistatus(...responses))
}

const proppatch = async (req: Request, resource: Resource) => {
  const body = await readXml(req)
  if (body instanceof Response) return body
  if (!body || !is(body, DAV, "propertyupdate"))
    return reply(400, "Expected a DAV:propertyupdate body.\n")

  // Only a book's display name is writable. RFC 4918 makes PROPPATCH atomic, so
  // one refused property fails the rest with 424 and nothing is changed.
  const updates: { prop: XmlNode; remove: boolean }[] = []
  for (const op of body.children) {
    if (op.ns !== DAV || (op.name !== "set" && op.name !== "remove")) continue
    for (const prop of child(op, DAV, "prop")?.children ?? []) {
      updates.push({ prop, remove: op.name === "remove" })
    }
  }
  const allowed = (u: { prop: XmlNode; remove: boolean }) =>
    resource.kind === "book" &&
    !u.remove &&
    is(u.prop, DAV, "displayname") &&
    u.prop.text.trim().length > 0
  const refused = updates.filter((u) => !allowed(u))

  if (refused.length === 0 && resource.kind === "book") {
    for (const u of updates) {
      await db().execute({
        text: "UPDATE address_books SET name = $2 WHERE id = $1",
        values: [resource.book.id, u.prop.text.trim().slice(0, 200)],
      })
    }
  }
  const names = (list: typeof updates) => list.map((u) => el(u.prop.ns, u.prop.name))
  const ok = updates.filter(allowed)
  return xmlReply(
    207,
    multistatus(
      el(
        DAV,
        "response",
        hrefEl(resource.path),
        refused.length > 0 && propstat(names(refused), 403, "Forbidden"),
        ok.length > 0 &&
          (refused.length > 0
            ? propstat(names(ok), 424, "Failed Dependency")
            : propstat(names(ok), 200, "OK")),
      ),
    ),
  )
}

const contactResponse = (
  identity: MailIdentity,
  book: AddressBook,
  contact: Contact,
  request: PropRequest,
) =>
  responseFor(
    identity,
    { kind: "contact", path: contactPath(book, contact), book, contact, href: contact.href },
    request,
  )

const reportPropRequest = (body: XmlNode): PropRequest => {
  if (child(body, DAV, "allprop")) return { mode: "allprop" }
  if (child(body, DAV, "propname")) return { mode: "propname" }
  const prop = child(body, DAV, "prop")
  return { mode: "prop", props: prop?.children.map((c) => ({ ns: c.ns, name: c.name })) ?? [] }
}

const multiget = async (req: Request, identity: MailIdentity, book: AddressBook, body: XmlNode) => {
  const request = reportPropRequest(body)
  const responses: XmlOut[] = []
  const prefix = bookPath(book)
  for (const node of children(body, DAV, "href")) {
    const raw = node.text.trim()
    let path = ""
    try {
      path = new URL(raw, req.url).pathname
    } catch {
      path = ""
    }
    const name = path.startsWith(prefix) ? segmentsOf(path.slice(prefix.length))?.[0] : undefined
    const contact = name && validHref(name) ? await contactByHref(book.id, name) : null
    responses.push(
      contact
        ? contactResponse(identity, book, contact, request)
        : el(DAV, "response", hrefEl(raw), statusLine(404, "Not Found")),
    )
  }
  return xmlReply(207, multistatus(...responses))
}

const COLLATIONS = new Set(["i;unicode-casemap", "i;ascii-casemap", "i;octet"])

type Unsupported = { unsupported: XmlOut }

const textMatches = (values: string[], tm: XmlNode): boolean => {
  const collation = tm.attrs.collation ?? "i;unicode-casemap"
  if (!COLLATIONS.has(collation))
    throw { unsupported: el(CARDDAV, "supported-collation") } satisfies Unsupported
  const fold = collation === "i;octet" ? (s: string) => s : (s: string) => s.toLowerCase()
  const needle = fold(tm.text)
  const type = tm.attrs["match-type"] ?? "contains"
  const test = (value: string) => {
    const hay = fold(value)
    switch (type) {
      case "equals":
        return hay === needle
      case "starts-with":
        return hay.startsWith(needle)
      case "ends-with":
        return hay.endsWith(needle)
      case "contains":
        return hay.includes(needle)
      default:
        throw { unsupported: el(CARDDAV, "supported-filter") } satisfies Unsupported
    }
  }
  const hit = values.some(test)
  return tm.attrs["negate-condition"] === "yes" ? !hit : hit
}

const propFilterMatches = (card: Vcard, filter: XmlNode): boolean => {
  const name = (filter.attrs.name ?? "").toUpperCase()
  const values = card.properties.filter((p) => p.name === name).map((p) => unescapeValue(p.value))
  if (child(filter, CARDDAV, "is-not-defined")) return values.length === 0
  if (children(filter, CARDDAV, "param-filter").length) {
    throw { unsupported: el(CARDDAV, "supported-filter") } satisfies Unsupported
  }
  const tests = children(filter, CARDDAV, "text-match")
  if (!tests.length) return values.length > 0
  const results = tests.map((tm) => textMatches(values, tm))
  return filter.attrs.test === "allof" ? results.every(Boolean) : results.some(Boolean)
}

/**
 * addressbook-query, evaluated over the parsed cards rather than in SQL. A book
 * is one person's contacts; parsing a few thousand short cards is cheaper than
 * a query language that has to agree with the vCard escaping rules.
 */
const query = async (identity: MailIdentity, book: AddressBook, body: XmlNode) => {
  const request = reportPropRequest(body)
  const filter = child(body, CARDDAV, "filter")
  const propFilters = children(filter, CARDDAV, "prop-filter")
  const allOf = filter?.attrs.test === "allof"
  const limitText = child(child(body, CARDDAV, "limit"), CARDDAV, "nresults")?.text.trim()
  const limit = limitText && /^\d+$/.test(limitText) ? Number(limitText) : Number.POSITIVE_INFINITY

  const matched: Contact[] = []
  let truncated = false
  try {
    for (const contact of await liveContacts(book.id)) {
      if (propFilters.length) {
        let card: Vcard
        try {
          card = parseVcard(contact.vcard)
        } catch {
          continue
        }
        const results = propFilters.map((f) => propFilterMatches(card, f))
        if (!(allOf ? results.every(Boolean) : results.some(Boolean))) continue
      }
      if (matched.length >= limit) {
        truncated = true
        break
      }
      matched.push(contact)
    }
  } catch (error) {
    const unsupported = (error as Partial<Unsupported>)?.unsupported
    if (unsupported) return conditionFailed(403, unsupported)
    throw error
  }

  return xmlReply(
    207,
    multistatus(
      ...matched.map((c) => contactResponse(identity, book, c, request)),
      // RFC 6352 8.6.1: a truncated result says so with a 507 for the collection.
      truncated &&
        el(DAV, "response", hrefEl(bookPath(book)), statusLine(507, "Insufficient Storage")),
    ),
  )
}

/**
 * RFC 6578 sync-collection.
 *
 * The book's token is read before its changes. A write that commits between the
 * two then shows up in this answer *and* the next one, which a client handles;
 * reading them the other way round could hand out a token that silently skips it.
 */
const syncCollection = async (identity: MailIdentity, book: AddressBook, body: XmlNode) => {
  const request = reportPropRequest(body)
  const given = child(body, DAV, "sync-token")?.text.trim() ?? ""
  const current = await bookToken(book.id)

  let since = 0
  if (given) {
    const match = given.match(/^urn:corsair:sync:([0-9a-f-]{36}):(\d{1,18})$/)
    const value = match ? Number(match[2]) : Number.NaN
    if (!match || match[1] !== book.id || value > current) {
      return conditionFailed(403, el(DAV, "valid-sync-token"))
    }
    since = value
  }

  const changed = given ? await changesSince(book.id, since) : await liveContacts(book.id)
  const responses = changed.map((contact) =>
    contact.deleted_at
      ? el(DAV, "response", hrefEl(contactPath(book, contact)), statusLine(404, "Not Found"))
      : contactResponse(identity, book, contact, request),
  )
  return xmlReply(
    207,
    el(DAV, "multistatus", ...responses, el(DAV, "sync-token", tokenOf(book, current))),
  )
}

const reportMethod = async (req: Request, identity: MailIdentity, resource: Resource) => {
  const body = await readXml(req)
  if (body instanceof Response) return body
  if (!body) return reply(400, "REPORT needs a body.\n")
  if (resource.kind !== "book") return conditionFailed(403, el(DAV, "supported-report"))

  const book = resource.book
  if (is(body, CARDDAV, "addressbook-multiget")) return multiget(req, identity, book, body)
  if (is(body, CARDDAV, "addressbook-query")) return query(identity, book, body)
  if (is(body, DAV, "sync-collection")) return syncCollection(identity, book, body)
  return conditionFailed(403, el(DAV, "supported-report"))
}

const preconditionOf = (req: Request): Precondition => ({
  ifMatch: req.headers.get("if-match"),
  ifNoneMatch: req.headers.get("if-none-match"),
})

const writeFailed = (result: Exclude<WriteResult, { ok: true }>) => {
  if (result.reason === "precondition") return reply(412, "Precondition failed.\n")
  if (result.reason === "not_found") return reply(404, "Not found.\n")
  return conditionFailed(403, el(CARDDAV, "no-uid-conflict", hrefEl(result.href ?? "")))
}

const VCARD_TYPES = new Set(["text/vcard", "text/x-vcard", "text/directory"])

const put = async (req: Request, resource: Resource) => {
  if (resource.kind !== "contact")
    return reply(405, "Only a contact can be written.\n", { allow: ALLOW })

  const type = req.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  if (type && !VCARD_TYPES.has(type))
    return conditionFailed(403, el(CARDDAV, "supported-address-data"))

  let vcard: string | null
  try {
    vcard = await readCapped(req, MAX_VCARD_BYTES)
  } catch {
    return conditionFailed(403, el(CARDDAV, "valid-address-data"))
  }
  if (vcard === null) return conditionFailed(403, el(CARDDAV, "max-resource-size"))

  let result: WriteResult
  try {
    result = await putContact({
      book: resource.book,
      href: resource.href,
      vcard,
      precondition: preconditionOf(req),
    })
  } catch (error) {
    if (isVcardError(error)) return conditionFailed(403, el(CARDDAV, "valid-address-data"))
    // Two PUTs racing on one UID both pass the in-transaction check only if the
    // index is what catches the second; it is still a UID conflict.
    if (
      (error as { errno?: string; code?: string }).errno === "23505" ||
      (error as { code?: string }).code === "23505"
    ) {
      return conditionFailed(403, el(CARDDAV, "no-uid-conflict"))
    }
    throw error
  }
  if (!result.ok) return writeFailed(result)
  return reply(result.created ? 201 : 204, null, { etag: `"${result.contact.etag}"` })
}

const getContact = (req: Request, resource: Resource, head: boolean) => {
  if (resource.kind !== "contact") return reply(405, "Not a contact.\n", { allow: ALLOW })
  const contact = resource.contact
  if (!contact) return reply(404, "Not found.\n")
  const etag = `"${contact.etag}"`
  const headers = {
    etag,
    "content-type": "text/vcard; charset=utf-8",
    "last-modified": httpDate(contact.updated_at),
  }
  const ifNone = req.headers.get("if-none-match")
  if (ifNone?.split(",").some((v) => v.trim().replace(/^W\//, "") === etag || v.trim() === "*")) {
    return reply(304, null, headers)
  }
  return new Response(head ? null : contact.vcard, {
    status: 200,
    headers: { "cache-control": "no-store", ...headers },
  })
}

const remove = async (req: Request, resource: Resource) => {
  if (resource.kind !== "contact") return reply(403, "Only a contact can be deleted.\n")
  const result = await deleteContact({
    book: resource.book,
    href: resource.href,
    precondition: preconditionOf(req),
  })
  return result.ok ? reply(204) : writeFailed(result)
}

const isDavPath = (pathname: string) => pathname === "/dav" || pathname.startsWith("/dav/")

/**
 * The CardDAV entry point. Returns null for any request that is not CardDAV's,
 * so the caller falls through to the router.
 */
export const handleDav = async (req: Request): Promise<Response | null> => {
  const url = new URL(req.url)
  const pathname = url.pathname

  // RFC 6764 6: a client given only a hostname starts here.
  if (pathname === "/.well-known/carddav" || pathname === "/.well-known/carddav/") {
    return reply(301, null, { location: ROOT })
  }
  // Some clients skip the well-known step and ask the server root directly.
  // Only PROPFIND is taken, so the docs site at "/" is untouched.
  const atRoot = pathname === "/" && req.method === "PROPFIND"
  if (!isDavPath(pathname) && !atRoot) return null

  const method = req.method.toUpperCase()
  if (method === "OPTIONS") {
    // Unauthenticated, as DAV clients probe with it before sending credentials.
    // There are no CORS headers on it, so a browser preflight for a cross-site
    // DAV write still fails.
    return reply(200, null, { dav: "1, 3, addressbook", allow: ALLOW })
  }

  const identity = await authenticate(req)
  if (identity instanceof Response) return identity

  // One book per mailbox. A client that offers "new address book" is told no
  // rather than given a collection nothing else here knows about.
  if (method === "MKCOL") return reply(403, "Each mailbox has one address book.\n")

  const target = await resolve(identity, pathname)
  if (target.kind === "missing") return reply(404, "Not found.\n")

  switch (method) {
    case "PROPFIND":
      return propfind(req, identity, target)
    case "PROPPATCH":
      return proppatch(req, target)
    case "REPORT":
      return reportMethod(req, identity, target)
    case "GET":
      return getContact(req, target, false)
    case "HEAD":
      return getContact(req, target, true)
    case "PUT":
      return put(req, target)
    case "DELETE":
      return remove(req, target)
    default:
      return reply(405, "Method not allowed.\n", { allow: ALLOW })
  }
}
