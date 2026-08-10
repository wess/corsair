/**
 * Renders `site/content/**.md` into `site/public/**.html`.
 *
 * A static build rather than rendering at request time: the marketing and docs
 * pages change when someone edits them, not per request, and a mail server
 * should not be parsing markdown on the same event loop that is accepting SMTP
 * connections. The same output is served two ways — by this server out of
 * `site/public`, and by GitHub Pages from the workflow in `.github/workflows`.
 *
 * Every link the generator emits is relative to the page that carries it, so
 * the tree works unchanged at a domain root, under a `/corsair/` project-page
 * prefix, or opened off a local disk.
 *
 * The markdown subset here is deliberately small — headings, nested lists,
 * tables, code, callouts, links, emphasis. Enough for documentation, no
 * dependency.
 */

import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

const CONTENT = new URL("./content/", import.meta.url).pathname
const ASSETS = new URL("./assets/", import.meta.url).pathname
const OUT = new URL("./public/", import.meta.url).pathname

/**
 * `app` is the site as this server serves it — the header offers the control
 * panel, because there is one. `pages` is the same content on GitHub Pages,
 * where `/app` would 404.
 */
const MODE = process.env.SITE_MODE === "pages" ? "pages" : "app"
const SITE_URL = (process.env.SITE_URL ?? "https://wess.github.io/corsair").replace(/\/+$/, "")
const REPO = "https://github.com/wess/corsair"

// ------------------------------------------------------------ front matter --

type Meta = {
  title: string
  description?: string
  /** Sidebar grouping for `docs/` pages; see `SECTIONS`. */
  section?: string
  /** Sort position within a section. */
  order?: number
  /** Sidebar label, when the page title is too long for it. */
  short?: string
  /** `home` drops the prose column and lets the page lay itself out. */
  layout?: string
  /** Small uppercase kicker above the page title. */
  eyebrow?: string
}

const parseFrontMatter = (raw: string): { meta: Meta; body: string } => {
  if (!raw.startsWith("---\n")) return { meta: { title: "Corsair" }, body: raw }
  const end = raw.indexOf("\n---", 4)
  if (end === -1) return { meta: { title: "Corsair" }, body: raw }

  const fields: Record<string, string> = {}
  for (const line of raw.slice(4, end).split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    fields[line.slice(0, colon).trim()] = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
  }
  return {
    meta: {
      title: fields.title ?? "Corsair",
      description: fields.description,
      section: fields.section,
      order: fields.order ? Number(fields.order) : undefined,
      short: fields.short,
      layout: fields.layout,
      eyebrow: fields.eyebrow,
    },
    body: raw.slice(end + 4),
  }
}

// ---------------------------------------------------------------- markdown --

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const inline = (text: string): string =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) =>
      href.startsWith("http")
        ? `<a href="${href}" class="external" rel="noopener">${label}</a>`
        : `<a href="${href}">${label}</a>`,
    )

const slugify = (text: string): string =>
  text
    .replace(/<[^>]+>/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

export type Heading = { level: number; text: string; id: string }

const CALLOUTS: Record<string, { label: string; mark: string }> = {
  note: { label: "Note", mark: "◆" },
  tip: { label: "Tip", mark: "★" },
  warning: { label: "Warning", mark: "▲" },
  danger: { label: "Stop", mark: "●" },
}

const indentOf = (line: string): number => line.length - line.trimStart().length

const LIST_MARKER = /^(\s*)([-*]|\d+[.)])\s+(.*)$/

/**
 * Renders a block of markdown, collecting headings as it goes.
 *
 * Recursive rather than a single flat pass: list items and `:::` callouts hold
 * arbitrary markdown, including code fences and further lists, and a tutorial
 * that cannot put a command inside step three is not much of a tutorial.
 */
const render = (markdown: string, headings: Heading[] = []): string => {
  const lines = markdown.split("\n")
  const out: string[] = []
  let i = 0

  const seen = new Map<string, number>()
  const uniqueId = (text: string): string => {
    const base = slugify(text) || "section"
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    return count === 0 ? base : `${base}-${count + 1}`
  }

  while (i < lines.length) {
    const line = lines[i]!

    // ------------------------------------------------------------- fences --
    if (line.trimStart().startsWith("```")) {
      const language = line.trim().slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.trimStart().startsWith("```")) {
        body.push(lines[i]!)
        i++
      }
      i++

      // A `raw` fence is emitted verbatim. Documentation occasionally needs a
      // small interactive widget, and the alternative is a second templating
      // system for the two pages that want one.
      if (language === "raw") {
        out.push(body.join("\n"))
        continue
      }

      const label = language ? `<span class="code-lang">${escapeHtml(language)}</span>` : ""
      out.push(
        `<figure class="code">${label}<pre><code>${escapeHtml(body.join("\n"))}</code></pre></figure>`,
      )
      continue
    }

    // ----------------------------------------------------------- callouts --
    const callout = line.match(/^:::(\w+)\s*(.*)$/)
    if (callout) {
      const kind = callout[1]!.toLowerCase()
      const spec = CALLOUTS[kind] ?? CALLOUTS.note!
      const title = callout[2]!.trim() || spec.label
      const body: string[] = []
      i++
      let depth = 1
      while (i < lines.length) {
        if (/^:::\w+/.test(lines[i]!)) depth++
        else if (lines[i]!.trim() === ":::") {
          depth--
          if (depth === 0) break
        }
        body.push(lines[i]!)
        i++
      }
      i++
      out.push(
        `<aside class="callout callout-${kind}"><p class="callout-title"><span aria-hidden="true">${spec.mark}</span>${inline(title)}</p>${render(body.join("\n"), headings)}</aside>`,
      )
      continue
    }

    // -------------------------------------------------------------- table --
    if (line.includes("|") && lines[i + 1]?.match(/^\s*\|?[\s:|-]+\|[\s:|-]*$/)) {
      const cells = (row: string) =>
        row
          .replace(/^\s*\|/, "")
          .replace(/\|\s*$/, "")
          .split("|")
          .map((c) => c.trim())

      const head = cells(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.includes("|")) {
        rows.push(cells(lines[i]!))
        i++
      }
      out.push("<div class='table-wrap'><table><thead><tr>")
      for (const cell of head) out.push(`<th>${inline(cell)}</th>`)
      out.push("</tr></thead><tbody>")
      for (const row of rows) {
        out.push("<tr>")
        for (const cell of row) out.push(`<td>${inline(cell)}</td>`)
        out.push("</tr>")
      }
      out.push("</tbody></table></div>")
      continue
    }

    // ------------------------------------------------------------ heading --
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      const level = heading[1]!.length
      const text = heading[2]!
      const id = uniqueId(text)
      if (level >= 2 && level <= 3) headings.push({ level, text: text.replace(/`/g, ""), id })
      const anchor =
        level === 1 ? "" : `<a class="anchor" href="#${id}" aria-label="Link to this section">#</a>`
      out.push(`<h${level} id="${id}">${inline(text)}${anchor}</h${level}>`)
      i++
      continue
    }

    // --------------------------------------------------------- blockquote --
    if (line.startsWith("> ")) {
      const body: string[] = []
      while (i < lines.length && lines[i]!.startsWith(">")) {
        body.push(lines[i]!.replace(/^>\s?/, ""))
        i++
      }
      out.push(`<blockquote>${render(body.join("\n"), headings)}</blockquote>`)
      continue
    }

    // --------------------------------------------------------------- rule --
    if (line.trim() === "---") {
      out.push('<hr class="rule" />')
      i++
      continue
    }

    if (line.trim() === "") {
      i++
      continue
    }

    // --------------------------------------------------------------- list --
    const marker = line.match(LIST_MARKER)
    if (marker) {
      const baseIndent = marker[1]!.length
      const ordered = /\d/.test(marker[2]!)
      const items: string[] = []

      while (i < lines.length) {
        const current = lines[i]!
        if (current.trim() === "") {
          // A blank line ends the list unless the next non-blank line is still
          // part of it. Without the lookahead, a step with a command under it
          // closes the list and the rest renders as loose paragraphs.
          let ahead = i + 1
          while (ahead < lines.length && lines[ahead]!.trim() === "") ahead++
          if (ahead >= lines.length) break
          const next = lines[ahead]!
          const nextMarker = next.match(LIST_MARKER)
          // A marker back at the base indent only continues this list if it is
          // the same kind. Switching from `1.` to `-` starts a new list, not a
          // stray item on the end of the old one.
          const continues = nextMarker
            ? nextMarker[1]!.length > baseIndent ||
              (nextMarker[1]!.length === baseIndent && /\d/.test(nextMarker[2]!) === ordered)
            : indentOf(next) > baseIndent
          if (!continues) break
          i = ahead
          continue
        }

        const item = current.match(LIST_MARKER)
        if (!item || item[1]!.length !== baseIndent) break
        if (/\d/.test(item[2]!) !== ordered) break

        const contentIndent = baseIndent + item[2]!.length + 1
        const lead: string[] = [item[3]!]
        i++

        // A wrapped item continues on the following lines, at whatever indent
        // the author used. Anything non-blank directly under the marker that
        // does not itself open a block is the same sentence — testing the
        // indent here instead would split a correctly-indented wrap into a
        // stray second paragraph.
        while (
          i < lines.length &&
          lines[i]!.trim() !== "" &&
          !LIST_MARKER.test(lines[i]!) &&
          !/^\s*(```|:::|#{1,4}\s|>\s)/.test(lines[i]!)
        ) {
          lead.push(lines[i]!.trim())
          i++
        }

        const nested: string[] = []
        while (i < lines.length) {
          if (lines[i]!.trim() === "") {
            let ahead = i + 1
            while (ahead < lines.length && lines[ahead]!.trim() === "") ahead++
            if (ahead >= lines.length || indentOf(lines[ahead]!) < contentIndent) break
            nested.push("")
            i = ahead
            continue
          }
          if (indentOf(lines[i]!) < contentIndent) break
          nested.push(lines[i]!.slice(contentIndent))
          i++
        }

        const body = nested.length ? render(nested.join("\n"), headings) : ""

        // `- [ ]` / `- [x]` is a checklist entry. The checklists in this manual
        // are things an operator ticks off on a real server, so they render as
        // boxes rather than as literal brackets.
        let text = lead.join(" ")
        const task = text.match(/^\[([ xX])\]\s+(.*)$/s)
        const cls = task ? ' class="task"' : ""
        if (task) {
          text = `<span class="box" aria-hidden="true">${task[1]!.trim() ? "✓" : ""}</span>${inline(task[2]!)}`
        } else {
          text = inline(text)
        }

        items.push(body ? `<li${cls}><p>${text}</p>${body}</li>` : `<li${cls}>${text}</li>`)
      }

      const tag = ordered ? "ol" : "ul"
      out.push(`<${tag}>${items.join("")}</${tag}>`)
      continue
    }

    // ---------------------------------------------------------- paragraph --
    const paragraph: string[] = [lines[i]!]
    i++
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,4}\s|>\s|```|:::|---\s*$)/.test(lines[i]!.trimStart()) &&
      !LIST_MARKER.test(lines[i]!)
    ) {
      paragraph.push(lines[i]!)
      i++
    }
    out.push(`<p>${inline(paragraph.join(" "))}</p>`)
  }

  return out.join("\n")
}

// -------------------------------------------------------------- navigation --

/** Sidebar groups, in the order they appear. A page names one in `section`. */
const SECTIONS = [
  { key: "start", label: "Start here" },
  { key: "tutorials", label: "Tutorials" },
  { key: "operate", label: "Install and operate" },
  { key: "using", label: "Using Corsair" },
  { key: "reference", label: "Reference" },
]

type Page = {
  /** Source path relative to `content/`, e.g. `docs/tutorials/first-server.md`. */
  source: string
  /** Output path relative to `public/`, e.g. `docs/tutorials/first-server.html`. */
  href: string
  meta: Meta
  body: string
}

/** A link from one output page to another, correct at any base path. */
const rel = (fromHref: string, toHref: string): string => {
  const path = relative(dirname(fromHref), toHref)
  return path.startsWith(".") ? path : `./${path}`
}

const TOP_NAV = [
  { href: "docs/index.html", label: "Docs" },
  { href: "docs/tutorials/index.html", label: "Tutorials" },
  { href: "faq.html", label: "FAQ" },
]

const FOOTER = [
  {
    label: "Corsair",
    links: [
      { href: "index.html", label: "Overview" },
      { href: "docs/introduction.html", label: "What it is" },
      { href: "docs/architecture.html", label: "Architecture" },
      { href: "faq.html", label: "Questions" },
      { href: "contact.html", label: "Contact" },
    ],
  },
  {
    label: "Documentation",
    links: [
      { href: "docs/index.html", label: "All documentation" },
      { href: "docs/quickstart.html", label: "Quickstart" },
      { href: "docs/tutorials/index.html", label: "Tutorials" },
      { href: "docs/configuration.html", label: "Configuration" },
      { href: "docs/api.html", label: "HTTP API" },
      { href: "docs/troubleshooting.html", label: "Troubleshooting" },
    ],
  },
  {
    label: "Project",
    links: [
      { href: REPO, label: "Source on GitHub" },
      { href: `${REPO}/issues`, label: "Issues" },
      { href: `${REPO}/blob/main/LICENSE`, label: "MIT license" },
      { href: "policies/privacy.html", label: "Privacy" },
      { href: "policies/acceptable-use.html", label: "Acceptable use" },
    ],
  },
]

const ATOM = `<svg class="mark" viewBox="0 0 44 44" aria-hidden="true" focusable="false">
<ellipse cx="22" cy="22" rx="20" ry="8.5" />
<ellipse cx="22" cy="22" rx="20" ry="8.5" transform="rotate(60 22 22)" />
<ellipse cx="22" cy="22" rx="20" ry="8.5" transform="rotate(120 22 22)" />
<circle class="nucleus" cx="22" cy="22" r="5" />
</svg>`

/**
 * The atomic starburst, drawn as one polygon alternating long and short spikes
 * around a small inner radius. Used exactly twice on the site — behind the hero
 * and behind the colophon — and never as filler.
 */
const STARBURST = (): string => {
  const points: string[] = []
  const spikes = 16
  for (let a = 0; a < spikes; a++) {
    const angle = (a * Math.PI * 2) / spikes - Math.PI / 2
    const outer = a % 2 === 0 ? 98 : 60
    const valley = angle + Math.PI / spikes
    points.push(
      `${(100 + Math.cos(angle) * outer).toFixed(1)},${(100 + Math.sin(angle) * outer).toFixed(1)}`,
      `${(100 + Math.cos(valley) * 22).toFixed(1)},${(100 + Math.sin(valley) * 22).toFixed(1)}`,
    )
  }
  return `<svg class="starburst" viewBox="0 0 200 200" aria-hidden="true" focusable="false"><polygon points="${points.join(" ")}" /></svg>`
}

// ------------------------------------------------------------------ layout --

const tocHtml = (headings: Heading[]): string => {
  if (headings.length < 2) return ""
  const items = headings
    .map((h) => `<li class="toc-h${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
    .join("")
  return `<nav class="toc" aria-label="On this page"><p class="toc-title">On this page</p><ul>${items}</ul></nav>`
}

const sidebarHtml = (pages: Page[], current: Page): string => {
  const groups = SECTIONS.map((section) => {
    const entries = pages
      .filter((p) => p.meta.section === section.key)
      .sort((a, b) => (a.meta.order ?? 999) - (b.meta.order ?? 999))
    return { section, entries }
  }).filter((g) => g.entries.length > 0)

  const body = groups
    .map(
      (g, index) => `<div class="side-group">
<p class="side-label"><span class="side-num">${String(index + 1).padStart(2, "0")}</span>${escapeHtml(g.section.label)}</p>
<ul>${g.entries
        .map((entry) => {
          const active = entry.href === current.href ? ' class="active" aria-current="page"' : ""
          const label = entry.meta.short ?? entry.meta.title
          return `<li><a href="${rel(current.href, entry.href)}"${active}>${escapeHtml(label)}</a></li>`
        })
        .join("")}</ul>
</div>`,
    )
    .join("\n")

  return `<nav class="sidebar" aria-label="Documentation">${body}</nav>`
}

const pagerHtml = (pages: Page[], current: Page): string => {
  const ordered = SECTIONS.flatMap((section) =>
    pages
      .filter((p) => p.meta.section === section.key)
      .sort((a, b) => (a.meta.order ?? 999) - (b.meta.order ?? 999)),
  )
  const at = ordered.findIndex((p) => p.href === current.href)
  if (at === -1) return ""

  const previous = ordered[at - 1]
  const next = ordered[at + 1]
  if (!previous && !next) return ""

  const link = (page: Page | undefined, direction: "prev" | "next"): string =>
    page
      ? `<a class="pager-${direction}" href="${rel(current.href, page.href)}"><span>${direction === "prev" ? "Previous" : "Next"}</span><strong>${escapeHtml(page.meta.title)}</strong></a>`
      : "<span></span>"

  return `<nav class="pager">${link(previous, "prev")}${link(next, "next")}</nav>`
}

const layout = (input: { page: Page; pages: Page[]; headings: Heading[] }): string => {
  const { page, pages, headings } = input
  const here = page.href
  const isDoc = here.startsWith("docs/") && page.meta.layout !== "home"
  const isHome = page.meta.layout === "home"

  // Tutorials live under `docs/`, so a plain prefix test would light both tabs.
  const inTutorials = here.startsWith("docs/tutorials/")
  const nav = TOP_NAV.map((item) => {
    const active =
      here === item.href ||
      (item.href === "docs/tutorials/index.html" && inTutorials) ||
      (item.href === "docs/index.html" && here.startsWith("docs/") && !inTutorials)
    return `<a href="${rel(here, item.href)}"${active ? ' class="on"' : ""}>${escapeHtml(item.label)}</a>`
  }).join("")

  const title =
    here === "index.html" ? "Corsair — self-hosted email" : `${page.meta.title} · Corsair`
  const canonical = `${SITE_URL}/${here === "index.html" ? "" : here}`

  const header = `<header class="masthead">
  <a class="brand" href="${rel(here, "index.html")}">${ATOM}<span>Corsair</span></a>
  <button class="menu" aria-expanded="false" aria-controls="site-nav" aria-label="Menu"><span></span><span></span><span></span></button>
  <nav id="site-nav" class="masthead-nav">
    ${nav}
    <a class="ghost" href="${REPO}" rel="noopener">GitHub</a>
    <button class="theme" type="button" aria-label="Switch between light and dark" title="Light or dark">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5.2" /><path d="M12 1.4v3.2M12 19.4v3.2M1.4 12h3.2M19.4 12h3.2M4.5 4.5l2.3 2.3M17.2 17.2l2.3 2.3M19.5 4.5l-2.3 2.3M6.8 17.2l-2.3 2.3" /></svg>
    </button>
    ${MODE === "app" ? `<a class="cta" href="/app">Control panel</a>` : `<a class="cta" href="${rel(here, "docs/quickstart.html")}">Get started</a>`}
  </nav>
</header>`

  const footer = `<footer class="colophon">
  <div class="colophon-burst">${STARBURST()}</div>
  <div class="colophon-grid">
    <div class="colophon-brand">
      <a class="brand" href="${rel(here, "index.html")}">${ATOM}<span>Corsair</span></a>
      <p>Self-hostable email. SMTP, IMAP, POP3, JMAP, webmail, and a control panel in one process.</p>
      <p class="plaque">MIT licensed · No telemetry</p>
    </div>
    ${FOOTER.map(
      (column) => `<div>
      <p class="colophon-label">${escapeHtml(column.label)}</p>
      <ul>${column.links
        .map(
          (l) =>
            `<li><a href="${l.href.startsWith("http") ? l.href : rel(here, l.href)}"${l.href.startsWith("http") ? ' rel="noopener"' : ""}>${escapeHtml(l.label)}</a></li>`,
        )
        .join("")}</ul>
    </div>`,
    ).join("")}
  </div>
</footer>`

  const heading = isHome
    ? ""
    : `<div class="page-head">${page.meta.eyebrow ? `<p class="eyebrow">${escapeHtml(page.meta.eyebrow)}</p>` : ""}</div>`

  const main = isHome
    ? `<main class="home">${page.body}</main>`
    : isDoc
      ? `<div class="docs-shell">
${sidebarHtml(pages, page)}
<main class="prose">${heading}${page.body}${pagerHtml(pages, page)}</main>
${tocHtml(headings)}
</div>`
      : `<main class="prose plain">${heading}${page.body}</main>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${escapeHtml(title)}</title>
${page.meta.description ? `<meta name="description" content="${escapeHtml(page.meta.description)}" />` : ""}
<link rel="canonical" href="${escapeHtml(canonical)}" />
<meta property="og:title" content="${escapeHtml(page.meta.title)}" />
<meta property="og:site_name" content="Corsair" />
${page.meta.description ? `<meta property="og:description" content="${escapeHtml(page.meta.description)}" />` : ""}
<meta property="og:type" content="website" />
<meta property="og:url" content="${escapeHtml(canonical)}" />
<meta name="twitter:card" content="summary" />
<link rel="icon" href="${rel(here, "favicon.svg")}" type="image/svg+xml" />
<link rel="stylesheet" href="${rel(here, "style.css")}" />
<script>/* Applied before first paint so a chosen theme does not flash the other one. */
try{var t=localStorage.getItem("corsair-theme");if(t)document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>
</head>
<body class="${isHome ? "is-home" : isDoc ? "is-doc" : "is-page"}">
<a class="skip" href="#content">Skip to content</a>
${header}
<div id="content">
${main}
</div>
${footer}
<script src="${rel(here, "docs.js")}" defer></script>
</body>
</html>
`
}

// ------------------------------------------------------------------- build --

const walk = async (dir: string, base = dir): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(full, base)))
    else if (entry.name.endsWith(".md")) files.push(relative(base, full))
  }
  return files
}

const sitemap = (pages: Page[]): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${pages
  .map(
    (p) =>
      `  <url><loc>${SITE_URL}/${p.href === "index.html" ? "" : p.href}</loc><priority>${p.href === "index.html" ? "1.0" : p.href.startsWith("docs/") ? "0.8" : "0.5"}</priority></url>`,
  )
  .join("\n")}
</urlset>
`

export const build = async (): Promise<number> => {
  const files = await walk(CONTENT)
  await mkdir(OUT, { recursive: true })

  const pages: Page[] = []
  for (const file of files) {
    const raw = await readFile(join(CONTENT, file), "utf8")
    const { meta, body } = parseFrontMatter(raw)
    pages.push({ source: file, href: file.replace(/\.md$/, ".html"), meta, body })
  }

  for (const page of pages) {
    const headings: Heading[] = []
    const rendered = render(page.body, headings).replaceAll("{{starburst}}", STARBURST())
    const html = layout({ page: { ...page, body: rendered }, pages, headings })
    const target = join(OUT, page.href)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, html)
  }

  await cp(ASSETS, OUT, { recursive: true })

  // GitHub Pages runs Jekyll over an artifact unless told not to, which drops
  // anything it considers a special path.
  await writeFile(join(OUT, ".nojekyll"), "")
  await writeFile(
    join(OUT, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}/sitemap.xml\n`,
  )
  await writeFile(join(OUT, "sitemap.xml"), sitemap(pages))

  // Pages serves 404.html for anything it cannot resolve. It is served from
  // arbitrary depths, so its links have to be absolute to the site root.
  const missing = pages.find((p) => p.href === "404.html")
  if (!missing) {
    await writeFile(
      join(OUT, "404.html"),
      layout({
        page: {
          source: "404.md",
          href: "404.html",
          meta: { title: "Not found", eyebrow: "Error 404" },
          body: render(
            "# Nothing at that address\n\nThe page moved, or it never existed.\n\n- [Documentation](docs/index.html)\n- [Quickstart](docs/quickstart.html)\n- [Home](index.html)\n",
          ),
        },
        pages,
        headings: [],
      }),
    )
  }

  return pages.length
}

if (import.meta.main) {
  const count = await build()
  console.log(`built ${count} page(s) into site/public (${MODE} mode)`)
}
