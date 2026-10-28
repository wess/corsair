/**
 * Just enough XML for DMARC aggregate reports, read and written.
 *
 * The input is from a stranger, so this is the subset that schema uses and
 * nothing else: elements, text, CDATA, comments, the five predefined entities
 * and numeric character references. A DOCTYPE is refused outright rather than
 * skipped — it is the only way to declare an entity, and declared entities are
 * how XML parsers get turned into file readers (XXE) and memory bombs
 * (billion laughs). Attributes are read past and dropped; the report schema
 * keeps every value in element text. Namespace prefixes are stripped, so a
 * report using the draft `dmarc:` namespace reads the same.
 */

export type XmlNode = { name: string; text: string; children: XmlNode[] }

const MAX_DEPTH = 32
const MAX_NODES = 200_000

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

const decodeEntities = (input: string): string =>
  input.includes("&")
    ? input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ref: string) => {
        if (ref[0] === "#") {
          const code =
            ref[1] === "x" || ref[1] === "X"
              ? Number.parseInt(ref.slice(2), 16)
              : Number.parseInt(ref.slice(1), 10)
          return Number.isFinite(code) && code > 0 && code <= 0x10ffff
            ? String.fromCodePoint(code)
            : ""
        }
        return ENTITIES[ref.toLowerCase()] ?? whole
      })
    : input

const localName = (qname: string): string => {
  const colon = qname.indexOf(":")
  return (colon === -1 ? qname : qname.slice(colon + 1)).toLowerCase()
}

export const parseXml = (input: string): XmlNode => {
  const root: XmlNode = { name: "#document", text: "", children: [] }
  const stack: XmlNode[] = [root]
  let nodes = 0
  let i = 0
  const n = input.length

  while (i < n) {
    const lt = input.indexOf("<", i)
    const textEnd = lt === -1 ? n : lt
    if (textEnd > i) {
      const top = stack[stack.length - 1]!
      if (stack.length > 1) top.text += decodeEntities(input.slice(i, textEnd))
    }
    if (lt === -1) break
    i = lt

    if (input.startsWith("<!--", i)) {
      const end = input.indexOf("-->", i + 4)
      if (end === -1) throw new Error("Unterminated XML comment.")
      i = end + 3
      continue
    }
    if (input.startsWith("<![CDATA[", i)) {
      const end = input.indexOf("]]>", i + 9)
      if (end === -1) throw new Error("Unterminated CDATA section.")
      if (stack.length > 1) stack[stack.length - 1]!.text += input.slice(i + 9, end)
      i = end + 3
      continue
    }
    if (input.startsWith("<?", i)) {
      const end = input.indexOf("?>", i + 2)
      if (end === -1) throw new Error("Unterminated processing instruction.")
      i = end + 2
      continue
    }
    if (input.startsWith("<!", i)) throw new Error("XML declarations (DOCTYPE) are not accepted.")

    const gt = input.indexOf(">", i)
    if (gt === -1) throw new Error("Unterminated XML tag.")
    const tag = input.slice(i + 1, gt)
    i = gt + 1

    if (tag.startsWith("/")) {
      const name = localName(tag.slice(1).trim())
      const top = stack.pop()
      if (!top || top.name !== name || stack.length === 0)
        throw new Error(`Mismatched closing tag </${name}>.`)
      continue
    }

    const selfClosing = tag.endsWith("/")
    const body = selfClosing ? tag.slice(0, -1) : tag
    const nameMatch = body.match(/^\s*([A-Za-z_][\w.:-]*)/)
    if (!nameMatch) throw new Error("Malformed XML tag.")
    if (++nodes > MAX_NODES) throw new Error("XML document has too many elements.")
    const node: XmlNode = { name: localName(nameMatch[1]!), text: "", children: [] }
    stack[stack.length - 1]!.children.push(node)
    if (!selfClosing) {
      stack.push(node)
      if (stack.length > MAX_DEPTH) throw new Error("XML document is nested too deeply.")
    }
  }

  if (stack.length !== 1) throw new Error("XML document ended with unclosed elements.")
  return root
}

export const child = (node: XmlNode | undefined, name: string): XmlNode | undefined =>
  node?.children.find((c) => c.name === name)

export const childrenNamed = (node: XmlNode | undefined, name: string): XmlNode[] =>
  node ? node.children.filter((c) => c.name === name) : []

/** Trimmed text of a child element, or null when it is absent or empty. */
export const textOf = (node: XmlNode | undefined, name: string): string | null => {
  const value = child(node, name)?.text.trim()
  return value ? value : null
}

export const escapeXml = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // Control characters other than tab and line breaks are not legal XML 1.0
    // at all, escaped or not.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")

/**
 * An ordered list of `[name, value]` pairs rendered as indented XML. A repeated
 * element is the same name appearing twice; a null value is left out.
 */
export type XmlValue = string | number | null | undefined | XmlTree
export type XmlTree = [string, XmlValue][]

export const renderXml = (tree: XmlTree, depth = 0): string => {
  const pad = "  ".repeat(depth)
  const out: string[] = []
  for (const [name, value] of tree) {
    if (value === null || value === undefined) continue
    if (typeof value === "string" || typeof value === "number") {
      out.push(`${pad}<${name}>${escapeXml(String(value))}</${name}>`)
    } else {
      out.push(`${pad}<${name}>\n${renderXml(value, depth + 1)}\n${pad}</${name}>`)
    }
  }
  return out.join("\n")
}
