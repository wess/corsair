/**
 * Just enough XML for WebDAV, and deliberately no more.
 *
 * A DAV request body is a small tree of namespaced elements. What matters is the
 * namespace each element resolves to, never its prefix — `<D:prop>` and
 * `<prop xmlns="DAV:">` are the same thing, and clients pick prefixes freely.
 * So every element comes out of the parser as `{ ns, name }`.
 *
 * Everything here is attacker-supplied, so the parser refuses anything that can
 * make a small input expensive: a DOCTYPE is rejected outright (no internal
 * subset, so no entity expansion), only the five predefined entities and
 * numeric references are understood, and depth and element count are capped.
 */

export const DAV = "DAV:"
export const CARDDAV = "urn:ietf:params:xml:ns:carddav"
export const CS = "http://calendarserver.org/ns/"

export type XmlNode = {
  ns: string
  name: string
  /** Unprefixed attributes only; DAV never puts meaning in a namespaced one. */
  attrs: Record<string, string>
  children: XmlNode[]
  text: string
}

const MAX_DEPTH = 64
const MAX_ELEMENTS = 20_000

const fail = (message: string): never => {
  throw Object.assign(new Error(`invalid XML: ${message}`), { xml: true })
}

export const isXmlError = (error: unknown): boolean =>
  Boolean((error as { xml?: boolean } | null)?.xml)

const PREDEFINED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
}

const decodeEntities = (raw: string): string =>
  raw.indexOf("&") === -1
    ? raw
    : raw.replace(/&([^;&\s]{1,10});|&/g, (match, ref: string | undefined) => {
        if (!ref) return fail("bare ampersand")
        if (ref[0] === "#") {
          const code = ref[1] === "x" ? Number.parseInt(ref.slice(2), 16) : Number(ref.slice(1))
          if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff)
            return fail(`bad reference ${match}`)
          return String.fromCodePoint(code)
        }
        const known = PREDEFINED[ref]
        return known ?? fail(`unknown entity ${match}`)
      })

const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/

export const parseXml = (input: string): XmlNode => {
  if (/<!DOCTYPE/i.test(input) || /<!ENTITY/i.test(input)) fail("DOCTYPE is not accepted")

  let pos = 0
  let elements = 0
  let root: XmlNode | null = null
  // Each open element carries its namespace scope: prefix → URI, "" for default.
  const stack: { node: XmlNode; qname: string; scope: Map<string, string> }[] = []

  const resolve = (qname: string, scope: Map<string, string>, isAttr: boolean) => {
    const colon = qname.indexOf(":")
    if (colon === -1) return { ns: isAttr ? "" : (scope.get("") ?? ""), name: qname }
    const prefix = qname.slice(0, colon)
    const ns = prefix === "xml" ? "http://www.w3.org/XML/1998/namespace" : scope.get(prefix)
    if (ns === undefined) fail(`undeclared prefix ${prefix}`)
    return { ns: ns as string, name: qname.slice(colon + 1) }
  }

  const appendText = (raw: string) => {
    const top = stack[stack.length - 1]
    if (!top) {
      if (raw.trim()) fail("text outside the root element")
      return
    }
    top.node.text += raw
  }

  while (pos < input.length) {
    const lt = input.indexOf("<", pos)
    if (lt === -1) {
      appendText(decodeEntities(input.slice(pos)))
      break
    }
    if (lt > pos) appendText(decodeEntities(input.slice(pos, lt)))

    if (input.startsWith("<?", lt)) {
      const end = input.indexOf("?>", lt + 2)
      if (end === -1) fail("unterminated processing instruction")
      pos = end + 2
      continue
    }
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4)
      if (end === -1) fail("unterminated comment")
      pos = end + 3
      continue
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9)
      if (end === -1) fail("unterminated CDATA")
      appendText(input.slice(lt + 9, end))
      pos = end + 3
      continue
    }
    if (input.startsWith("<!", lt)) fail("markup declarations are not accepted")

    const gt = input.indexOf(">", lt)
    if (gt === -1) fail("unterminated tag")

    if (input[lt + 1] === "/") {
      const qname = input.slice(lt + 2, gt).trim()
      const open = stack.pop()
      if (!open || open.qname !== qname) fail(`mismatched </${qname}>`)
      pos = gt + 1
      continue
    }

    // Attribute values may legally contain ">", so the end of the tag is found
    // by walking quotes rather than by the first ">".
    let end = lt + 1
    let quote = ""
    for (; end < input.length; end++) {
      const ch = input[end]
      if (quote) {
        if (ch === quote) quote = ""
      } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === ">") break
    }
    if (end >= input.length) fail("unterminated tag")

    let body = input.slice(lt + 1, end)
    const selfClosing = body.endsWith("/")
    if (selfClosing) body = body.slice(0, -1)

    const nameMatch = body.match(/^[^\s/>]+/)
    const qname = nameMatch?.[0] ?? ""
    if (!NAME.test(qname)) fail(`bad element name ${JSON.stringify(qname)}`)

    const rawAttrs: [string, string][] = []
    const attrPattern = /\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
    const rest = body.slice(qname.length)
    let consumed = 0
    for (const m of rest.matchAll(attrPattern)) {
      if (m.index !== consumed) fail("malformed attributes")
      consumed = m.index + m[0].length
      rawAttrs.push([m[1]!, decodeEntities(m[3] ?? m[4] ?? "")])
    }
    if (rest.slice(consumed).trim()) fail("malformed attributes")

    const parentScope = stack[stack.length - 1]?.scope ?? new Map<string, string>()
    let scope = parentScope
    for (const [key, value] of rawAttrs) {
      if (key === "xmlns" || key.startsWith("xmlns:")) {
        if (scope === parentScope) scope = new Map(parentScope)
        scope.set(key === "xmlns" ? "" : key.slice(6), value)
      }
    }

    const { ns, name } = resolve(qname, scope, false)
    const attrs: Record<string, string> = {}
    for (const [key, value] of rawAttrs) {
      if (key === "xmlns" || key.startsWith("xmlns:")) continue
      if (!NAME.test(key)) fail(`bad attribute name ${key}`)
      if (resolve(key, scope, true).ns === "") attrs[key] = value
    }

    if (++elements > MAX_ELEMENTS) fail("too many elements")
    const node: XmlNode = { ns, name, attrs, children: [], text: "" }
    const parent = stack[stack.length - 1]
    if (parent) parent.node.children.push(node)
    else if (root) fail("more than one root element")
    else root = node

    if (!selfClosing) {
      stack.push({ node, qname, scope })
      if (stack.length > MAX_DEPTH) fail("nested too deeply")
    }
    pos = end + 1
  }

  if (stack.length) fail(`unclosed <${stack[stack.length - 1]!.qname}>`)
  if (!root) fail("no root element")
  return root as XmlNode
}

export const child = (node: XmlNode | undefined, ns: string, name: string): XmlNode | undefined =>
  node?.children.find((c) => c.ns === ns && c.name === name)

export const children = (node: XmlNode | undefined, ns: string, name: string): XmlNode[] =>
  node?.children.filter((c) => c.ns === ns && c.name === name) ?? []

export const is = (node: XmlNode | undefined, ns: string, name: string): boolean =>
  Boolean(node && node.ns === ns && node.name === name)

// writing

/** An element to serialise. Text children are escaped; there is no raw path. */
export type XmlOut = {
  ns: string
  name: string
  attrs?: Record<string, string>
  children?: (XmlOut | string)[]
}

export const el = (
  ns: string,
  name: string,
  ...kids: (XmlOut | string | null | undefined | false)[]
): XmlOut => ({
  ns,
  name,
  children: kids.filter((k): k is XmlOut | string => k !== null && k !== undefined && k !== false),
})

export const escapeXml = (value: string): string =>
  value.replace(/[&<>"]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;",
  )

// XML 1.0 cannot carry most C0 controls even as references, so they are
// dropped rather than emitted into a document the client will refuse.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const INVALID_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g

const KNOWN_PREFIXES: Record<string, string> = { [DAV]: "d", [CARDDAV]: "card", [CS]: "cs" }

/**
 * Serialises a tree with every namespace declared once on the root.
 *
 * Unknown namespaces show up when a client asks for a property this server does
 * not have — it is echoed back under a 404 — so they get generated prefixes.
 */
export const serializeXml = (root: XmlOut): string => {
  const prefixes = new Map<string, string>()
  const collect = (node: XmlOut) => {
    if (node.ns && !prefixes.has(node.ns)) {
      prefixes.set(node.ns, KNOWN_PREFIXES[node.ns] ?? `x${prefixes.size}`)
    }
    for (const kid of node.children ?? []) if (typeof kid !== "string") collect(kid)
  }
  collect(root)

  const write = (node: XmlOut, isRoot: boolean): string => {
    const prefix = node.ns ? prefixes.get(node.ns) : undefined
    const tag = prefix ? `${prefix}:${node.name}` : node.name
    let attrs = ""
    if (isRoot) {
      for (const [ns, p] of prefixes) attrs += ` xmlns:${p}="${escapeXml(ns)}"`
    }
    for (const [key, value] of Object.entries(node.attrs ?? {})) {
      attrs += ` ${key}="${escapeXml(value.replace(INVALID_CHARS, ""))}"`
    }
    const kids = node.children ?? []
    if (!kids.length) return `<${tag}${attrs}/>`
    const inner = kids
      .map((kid) =>
        typeof kid === "string" ? escapeXml(kid.replace(INVALID_CHARS, "")) : write(kid, false),
      )
      .join("")
    return `<${tag}${attrs}>${inner}</${tag}>`
  }

  return `<?xml version="1.0" encoding="utf-8"?>\n${write(root, true)}`
}
