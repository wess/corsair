/**
 * Renders `site/content/**.md` into `site/public/**.html`.
 *
 * A static build rather than rendering at request time: the marketing and docs
 * pages change when someone edits them, not per request, and a mail server
 * should not be parsing markdown on the same event loop that is accepting SMTP
 * connections.
 *
 * The markdown subset here is deliberately small — headings, lists, tables,
 * code, links, emphasis. Enough for documentation, no dependency.
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"

const CONTENT = new URL("./content/", import.meta.url).pathname
const OUT = new URL("./public/", import.meta.url).pathname

type Meta = { title: string; description?: string; nav?: string; order?: number }

const parseFrontMatter = (raw: string): { meta: Meta; body: string } => {
  if (!raw.startsWith("---\n")) return { meta: { title: "Corsair" }, body: raw }
  const end = raw.indexOf("\n---", 4)
  if (end === -1) return { meta: { title: "Corsair" }, body: raw }

  const meta: Record<string, string> = {}
  for (const line of raw.slice(4, end).split("\n")) {
    const colon = line.indexOf(":")
    if (colon === -1) continue
    meta[line.slice(0, colon).trim()] = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "")
  }
  return {
    meta: {
      title: meta.title ?? "Corsair",
      description: meta.description,
      nav: meta.nav,
      order: meta.order ? Number(meta.order) : undefined,
    },
    body: raw.slice(end + 4),
  }
}

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const inline = (text: string): string =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')

const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

const render = (markdown: string): string => {
  const lines = markdown.split("\n")
  const out: string[] = []
  let i = 0
  let listType: "ul" | "ol" | null = null

  const closeList = () => {
    if (listType) {
      out.push(`</${listType}>`)
      listType = null
    }
  }

  while (i < lines.length) {
    const line = lines[i]!

    if (line.startsWith("```")) {
      closeList()
      const language = line.slice(3).trim()
      const body: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith("```")) {
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

      out.push(
        `<pre${language ? ` data-lang="${escapeHtml(language)}"` : ""}><code>${escapeHtml(body.join("\n"))}</code></pre>`,
      )
      continue
    }

    // A table is a header row, a separator, then body rows.
    if (line.includes("|") && lines[i + 1]?.match(/^\s*\|?[\s:|-]+\|[\s:|-]*$/)) {
      closeList()
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

    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      closeList()
      const level = heading[1]!.length
      const text = heading[2]!
      out.push(`<h${level} id="${slugify(text)}">${inline(text)}</h${level}>`)
      i++
      continue
    }

    if (line.startsWith("> ")) {
      closeList()
      const body: string[] = []
      while (i < lines.length && lines[i]!.startsWith("> ")) {
        body.push(lines[i]!.slice(2))
        i++
      }
      out.push(`<blockquote>${inline(body.join(" "))}</blockquote>`)
      continue
    }

    const bullet = /^\s*[-*]\s+/.test(line)
    const numbered = /^\s*\d+\.\s+/.test(line)
    if (bullet || numbered) {
      const wanted = bullet ? "ul" : "ol"
      if (listType !== wanted) {
        closeList()
        out.push(`<${wanted}>`)
        listType = wanted
      }

      // A wrapped item continues on the following lines. Without this, every
      // list item longer than one source line breaks out of the list and
      // renders as a stray paragraph after it.
      const item = [line.replace(bullet ? /^\s*[-*]\s+/ : /^\s*\d+\.\s+/, "")]
      i++
      while (
        i < lines.length &&
        lines[i]!.trim() !== "" &&
        !/^\s*([-*]\s|\d+\.\s)/.test(lines[i]!) &&
        !/^(#{1,4}\s|>\s|```)/.test(lines[i]!)
      ) {
        item.push(lines[i]!.trim())
        i++
      }
      out.push(`<li>${inline(item.join(" "))}</li>`)
      continue
    }

    if (line.trim() === "") {
      closeList()
      i++
      continue
    }

    if (line.trim() === "---") {
      closeList()
      out.push("<hr />")
      i++
      continue
    }

    closeList()

    // The first line is always consumed. Without that, a line that reaches here
    // but also matches the continuation guard below — `**Bold** at the start of
    // a paragraph is the common case — would leave the loop without advancing
    // `i`, and the whole build hangs.
    const paragraph: string[] = [lines[i]!]
    i++
    while (
      i < lines.length &&
      lines[i]!.trim() !== "" &&
      !/^(#{1,4}\s|>\s|```)/.test(lines[i]!) &&
      !/^\s*([-*]\s|\d+\.\s)/.test(lines[i]!)
    ) {
      paragraph.push(lines[i]!)
      i++
    }
    out.push(`<p>${inline(paragraph.join(" "))}</p>`)
  }

  closeList()
  return out.join("\n")
}

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

const layout = (input: {
  meta: Meta
  body: string
  nav: { href: string; label: string }[]
  depth: number
}): string => {
  const root = input.depth === 0 ? "." : "..".repeat(1) + "/..".repeat(input.depth - 1)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${escapeHtml(input.meta.title)} — Corsair</title>
${input.meta.description ? `<meta name="description" content="${escapeHtml(input.meta.description)}" />` : ""}
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🏴</text></svg>" />
<link rel="stylesheet" href="${root}/style.css" />
</head>
<body>
<header class="site-head">
  <a class="brand" href="${root}/index.html">🏴 Corsair</a>
  <nav>
    ${input.nav.map((n) => `<a href="${root}/${n.href}">${escapeHtml(n.label)}</a>`).join("\n    ")}
    <a class="cta" href="/app">Control panel</a>
  </nav>
</header>
<main>
${input.body}
</main>
<footer class="site-foot">
  <p>Corsair is open source email hosting, released under the MIT license.</p>
  <p><a href="https://github.com/wess/corsair">Source</a> · <a href="${root}/docs/index.html">Docs</a> · <a href="${root}/policies/privacy.html">Privacy</a> · <a href="${root}/policies/acceptable-use.html">Acceptable use</a></p>
</footer>
</body>
</html>
`
}

const NAV = [
  { href: "pricing.html", label: "Pricing" },
  { href: "faq.html", label: "FAQ" },
  { href: "docs/index.html", label: "Docs" },
  { href: "contact.html", label: "Contact" },
  { href: "affiliates.html", label: "Affiliates" },
]

export const build = async (): Promise<number> => {
  const files = await walk(CONTENT)
  await mkdir(OUT, { recursive: true })

  for (const file of files) {
    const raw = await readFile(join(CONTENT, file), "utf8")
    const { meta, body } = parseFrontMatter(raw)
    const target = join(OUT, file.replace(/\.md$/, ".html"))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(
      target,
      layout({ meta, body: render(body), nav: NAV, depth: file.split("/").length - 1 }),
    )
  }

  await writeFile(join(OUT, "style.css"), STYLE)
  return files.length
}

const STYLE = `:root {
  --bg: #ffffff;
  --surface: #f7f8fa;
  --border: #e2e6ec;
  --text: #131a23;
  --dim: #566173;
  --accent: #1d6ef5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --surface: #151b24;
    --border: #242c38;
    --text: #e9eef6;
    --dim: #97a3b4;
    --accent: #63a0ff;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--text);
  font: 16px/1.65 ui-sans-serif, -apple-system, "Segoe UI", Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.site-head {
  display: flex; align-items: center; justify-content: space-between; gap: 20px;
  padding: 18px 28px; border-bottom: 1px solid var(--border);
  position: sticky; top: 0; background: var(--bg); z-index: 5; flex-wrap: wrap;
}
.brand { font-size: 19px; font-weight: 700; letter-spacing: -0.02em; color: var(--text); }
.site-head nav { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.site-head nav a { color: var(--dim); font-weight: 500; }
.site-head nav a:hover { color: var(--text); }
.site-head .cta {
  padding: 7px 14px; border-radius: 8px; background: var(--accent); color: #fff;
}
.site-head .cta:hover { text-decoration: none; opacity: 0.92; }
main { max-width: 760px; margin: 0 auto; padding: 40px 28px 72px; }
h1 { font-size: 40px; line-height: 1.15; letter-spacing: -0.03em; margin: 0 0 20px; }
h2 { font-size: 26px; letter-spacing: -0.02em; margin: 44px 0 12px; }
h3 { font-size: 19px; margin: 30px 0 8px; }
h4 { font-size: 16px; margin: 24px 0 6px; color: var(--dim); }
p, li { color: var(--text); }
blockquote {
  margin: 20px 0; padding: 12px 18px; border-left: 3px solid var(--accent);
  background: var(--surface); border-radius: 0 8px 8px 0; color: var(--dim);
}
code {
  font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 0.88em;
  background: var(--surface); border: 1px solid var(--border);
  padding: 1px 5px; border-radius: 5px;
}
pre {
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
  padding: 16px; overflow-x: auto;
}
pre code { background: none; border: 0; padding: 0; font-size: 13.5px; line-height: 1.6; }
.table-wrap { overflow-x: auto; margin: 20px 0; }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
th, td { padding: 9px 12px; border-bottom: 1px solid var(--border); text-align: left; }
th { background: var(--surface); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--dim); }
hr { border: 0; border-top: 1px solid var(--border); margin: 36px 0; }
.site-foot {
  border-top: 1px solid var(--border); padding: 28px; text-align: center;
  color: var(--dim); font-size: 14px;
}
.site-foot p { margin: 4px 0; }
.lookup input {
  width: 100%; padding: 11px 14px; font: inherit; color: var(--text);
  background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
}
.lookup input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.lookup-empty { padding: 18px; text-align: center; color: var(--dim); }
tr[hidden] { display: none; }
`

if (import.meta.main) {
  const count = await build()
  console.log(`built ${count} page(s) into site/public`)
}
