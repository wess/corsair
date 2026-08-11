/**
 * Verifies every internal link in the built site resolves to a file that exists.
 *
 * A docs site's most common defect is a link that used to work. The generator
 * emits relative hrefs, so a page that moves between directories silently
 * breaks every link into it — and nothing at build time notices, because a
 * broken href is still valid HTML.
 *
 *   bun site/check.ts
 *
 * Exits non-zero on the first failure, so CI stops before publishing.
 */

import { readdir, readFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

const OUT = new URL("./public/", import.meta.url).pathname

const walk = async (dir: string): Promise<string[]> => {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(full)))
    else if (entry.name.endsWith(".html")) files.push(full)
  }
  return files
}

const exists = async (path: string): Promise<boolean> => Bun.file(path).exists()

const pages = await walk(OUT)
const broken: { page: string; href: string }[] = []
const anchorsMissing: { page: string; href: string }[] = []

for (const page of pages) {
  const html = await readFile(page, "utf8")
  const ids = new Set(Array.from(html.matchAll(/\sid="([^"]+)"/g), (m) => m[1]!))

  for (const match of html.matchAll(/href="([^"]+)"/g)) {
    const href = match[1]!

    // External, absolute, and non-navigational hrefs are out of scope: this
    // checks the tree it just built, not the internet.
    if (/^(https?:|mailto:|data:|#|\/)/.test(href)) {
      // A same-page anchor still has to point at something.
      if (href.startsWith("#") && href !== "#" && !ids.has(href.slice(1))) {
        anchorsMissing.push({ page: relative(OUT, page), href })
      }
      continue
    }

    const [path] = href.split("#")
    if (!path) continue

    const target = resolve(dirname(page), path)
    if (!(await exists(target))) broken.push({ page: relative(OUT, page), href })
  }
}

for (const { page, href } of broken) console.error(`broken link  ${page} → ${href}`)
for (const { page, href } of anchorsMissing) console.error(`dead anchor  ${page} → ${href}`)

if (broken.length || anchorsMissing.length) {
  console.error(`\n${broken.length} broken link(s), ${anchorsMissing.length} dead anchor(s)`)
  process.exit(1)
}

console.log(`checked ${pages.length} page(s), every internal link resolves`)
