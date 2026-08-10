/**
 * HTML sanitising for displayed mail.
 *
 * Rendering an attacker-supplied HTML document in a logged-in browser is the
 * largest attack surface any webmail has, and every mail a server accepts is
 * attacker-supplied by definition. This runs on the server, so the browser is
 * never handed the original at all.
 *
 * The policy is an **allow-list**: unknown tags and unknown attributes are
 * dropped rather than inspected. A deny-list of dangerous things is a losing
 * game — it has to be complete, and the set of dangerous things grows with
 * every browser release.
 *
 * Remote images are rewritten to a placeholder by default. A remote image in an
 * email is a tracking pixel that reports when it was opened and from which IP;
 * loading them is a choice the reader makes per message.
 */

const ALLOWED_TAGS = new Set([
  "a",
  "abbr",
  "address",
  "b",
  "blockquote",
  "br",
  "caption",
  "cite",
  "code",
  "col",
  "colgroup",
  "dd",
  "del",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "font",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
  "wbr",
])

/**
 * Tags whose *content* is discarded along with the tag. For most tags the text
 * inside is worth keeping; for these it is code, and unwrapping it would paste
 * a script body into the document as visible text at best.
 */
const DROP_CONTENT = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "template",
  "noscript",
  "form",
  "input",
  "button",
  "select",
  "textarea",
  "option",
  "svg",
  "math",
  "link",
  "meta",
  "base",
  "title",
  "head",
])

const ALLOWED_ATTRS = new Set([
  "href",
  "src",
  "alt",
  "title",
  "width",
  "height",
  "align",
  "valign",
  "colspan",
  "rowspan",
  "border",
  "cellpadding",
  "cellspacing",
  "color",
  "face",
  "size",
  "dir",
  "lang",
  "style",
  "class",
])

/**
 * A conservative subset of CSS. Mail is heavily styled and stripping all of it
 * makes newsletters unreadable, but `position`, `behavior`, and anything that
 * can load a URL are how CSS becomes an exploit or a tracker.
 */
const ALLOWED_CSS = new Set([
  "color",
  "background-color",
  "font-size",
  "font-family",
  "font-weight",
  "font-style",
  "text-align",
  "text-decoration",
  "line-height",
  "margin",
  "margin-top",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "padding",
  "padding-top",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "border",
  "border-top",
  "border-bottom",
  "border-left",
  "border-right",
  "border-color",
  "border-radius",
  "border-style",
  "border-width",
  "width",
  "height",
  "max-width",
  "min-width",
  "vertical-align",
  "display",
  "white-space",
  "letter-spacing",
  "text-transform",
])

const VOID_TAGS = new Set(["br", "hr", "img", "col", "wbr"])

const escapeText = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const escapeAttr = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * A URL is safe if it is http(s), mailto, or a cid: reference to an inline
 * attachment. Everything else — `javascript:`, `data:`, `vbscript:`, and any
 * scheme invented tomorrow — is refused by omission.
 *
 * The scheme is read after stripping the characters browsers ignore. `java\0
 * script:` and `java&#x09;script:` are both parsed as `javascript:`.
 */
const safeUrl = (raw: string): string | null => {
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers ignore these inside a scheme, so the check has to too
    .replace(/[\x00-\x20\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g, "")
    .toLowerCase()
  if (cleaned.startsWith("http://") || cleaned.startsWith("https://")) return raw.trim()
  if (cleaned.startsWith("mailto:")) return raw.trim()
  if (cleaned.startsWith("cid:")) return raw.trim()
  // A relative URL has no scheme, and in a mail body there is nothing sensible
  // for it to be relative to.
  return null
}

const sanitizeStyle = (value: string): string => {
  const out: string[] = []
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":")
    if (colon === -1) continue
    const property = declaration.slice(0, colon).trim().toLowerCase()
    const setting = declaration.slice(colon + 1).trim()
    if (!ALLOWED_CSS.has(property)) continue
    // No `url()`, no `expression()`, no escapes that could rebuild either.
    if (/url\s*\(|expression\s*\(|javascript:|@import|\\/i.test(setting)) continue
    out.push(`${property}:${setting}`)
  }
  return out.join(";")
}

export type SanitizeOptions = {
  /** Rewrites `cid:` references to a URL the reader can fetch. */
  resolveCid?: (cid: string) => string | null
  /** Loads remote images. Off by default — a remote image is a tracking pixel. */
  allowRemoteImages?: boolean
}

export type SanitizeResult = {
  html: string
  /** True when at least one remote image was withheld, so the UI can offer to load them. */
  blockedRemoteImages: boolean
}

type Attr = { name: string; value: string }

const parseAttrs = (source: string): Attr[] => {
  const out: Attr[] = []
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g
  for (const match of source.matchAll(pattern)) {
    const name = match[1]!.toLowerCase()
    let value = match[2] ?? ""
    if (value.startsWith('"') || value.startsWith("'")) value = value.slice(1, -1)
    out.push({ name, value: decodeEntities(value) })
  }
  return out
}

/** Enough entity decoding to see through an obfuscated scheme. */
const decodeEntities = (value: string): string =>
  value
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")

export const sanitizeHtml = (input: string, options: SanitizeOptions = {}): SanitizeResult => {
  let blockedRemoteImages = false
  const out: string[] = []
  const open: string[] = []

  let i = 0
  // The tag whose content is being discarded, and how deeply nested we are in
  // it — a <script> inside a <script> should not close the skip early.
  let skipping: string | null = null
  let skipDepth = 0

  while (i < input.length) {
    const lt = input.indexOf("<", i)
    if (lt === -1) {
      if (!skipping) out.push(escapeText(input.slice(i)))
      break
    }

    if (lt > i && !skipping) out.push(escapeText(input.slice(i, lt)))

    // Comments and CDATA are dropped whole. A conditional comment is how
    // Outlook-targeted markup hides, and it is not content.
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4)
      i = end === -1 ? input.length : end + 3
      continue
    }
    if (input.startsWith("<!", lt) || input.startsWith("<?", lt)) {
      const end = input.indexOf(">", lt)
      i = end === -1 ? input.length : end + 1
      continue
    }

    const gt = input.indexOf(">", lt)
    if (gt === -1) {
      if (!skipping) out.push(escapeText(input.slice(lt)))
      break
    }

    const inner = input.slice(lt + 1, gt)
    const closing = inner.startsWith("/")
    const body = closing ? inner.slice(1) : inner
    const nameMatch = body.match(/^([a-zA-Z][-a-zA-Z0-9:]*)/)
    i = gt + 1

    if (!nameMatch) continue
    const tag = nameMatch[1]!.toLowerCase()

    if (skipping) {
      if (tag === skipping) {
        if (closing) {
          skipDepth--
          if (skipDepth <= 0) skipping = null
        } else if (!body.trimEnd().endsWith("/")) skipDepth++
      }
      continue
    }

    if (DROP_CONTENT.has(tag)) {
      if (!closing && !body.trimEnd().endsWith("/")) {
        skipping = tag
        skipDepth = 1
      }
      continue
    }

    if (!ALLOWED_TAGS.has(tag)) continue

    if (closing) {
      // Only close a tag actually open, so stray closers cannot unbalance the
      // output and escape a container.
      const at = open.lastIndexOf(tag)
      if (at === -1) continue
      while (open.length > at) out.push(`</${open.pop()}>`)
      continue
    }

    const attrs: string[] = []
    for (const attr of parseAttrs(body.slice(nameMatch[1]!.length))) {
      // Every `on*` handler, in one rule, whether or not it exists yet.
      if (attr.name.startsWith("on")) continue
      if (!ALLOWED_ATTRS.has(attr.name)) continue

      if (attr.name === "href" || attr.name === "src") {
        const url = safeUrl(attr.value)
        if (!url) continue

        if (attr.name === "src" && tag === "img") {
          if (url.toLowerCase().startsWith("cid:")) {
            const resolved = options.resolveCid?.(url.slice(4))
            if (!resolved) continue
            attrs.push(`src="${escapeAttr(resolved)}"`)
            continue
          }
          if (!options.allowRemoteImages) {
            blockedRemoteImages = true
            // Kept as data-src so "load images" is a client-side toggle rather
            // than a second fetch of the whole message.
            attrs.push(`data-blocked-src="${escapeAttr(url)}"`)
            continue
          }
        }
        attrs.push(`${attr.name}="${escapeAttr(url)}"`)
        continue
      }

      if (attr.name === "style") {
        const style = sanitizeStyle(attr.value)
        if (style) attrs.push(`style="${escapeAttr(style)}"`)
        continue
      }

      attrs.push(`${attr.name}="${escapeAttr(attr.value)}"`)
    }

    // Every link opens in a new tab, and `noopener` stops the opened page
    // reaching back through window.opener to navigate the webmail.
    if (tag === "a") attrs.push('target="_blank"', 'rel="noopener noreferrer nofollow"')

    const selfClosing = VOID_TAGS.has(tag) || body.trimEnd().endsWith("/")
    out.push(`<${tag}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`)
    if (!selfClosing) open.push(tag)
  }

  while (open.length) out.push(`</${open.pop()}>`)
  return { html: out.join(""), blockedRemoteImages }
}

/** Renders a plain-text body as HTML, linkifying URLs and marking quoted lines. */
export const textToHtml = (input: string): string => {
  const lines = escapeText(input).split(/\r?\n/)
  const out = lines.map((line) => {
    const quoted = /^&gt;/.test(line)
    const linked = line.replace(
      /\bhttps?:\/\/[^\s<>"']+/g,
      (url) =>
        `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeText(url)}</a>`,
    )
    return quoted ? `<span class="quoted">${linked}</span>` : linked
  })
  return `<div class="plain">${out.join("<br />")}</div>`
}
