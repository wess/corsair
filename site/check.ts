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

/**
 * Every built page must come from a source file that is actually in the
 * repository.
 *
 * `.gitignore` carried an unanchored `SECURITY.md`, which git matches against
 * every path segment — and on a case-insensitive filesystem that swallowed
 * `site/content/docs/security.md`. The built HTML was committed, so the page
 * kept answering 200 and the link checker kept passing, while CI built the
 * whole site from a checkout that did not contain the source. The Security page
 * quietly vanished from the sidebar of every other page and became an orphan
 * reachable only by typing its URL.
 *
 * Nothing about that is visible from the output alone, which is why this checks
 * the source rather than the artifact.
 */
const untracked: string[] = []
const sourceless: string[] = []

const tracked = new Set(
  new TextDecoder()
    .decode(
      Bun.spawnSync(["git", "ls-files", "site/content"], {
        cwd: new URL("../", import.meta.url).pathname,
      }).stdout,
    )
    .split("\n")
    .filter(Boolean),
)

for (const page of pages) {
  const out = relative(OUT, page)
  // Emitted by the generator rather than authored; it has no markdown source.
  if (out === "404.html") continue

  const source = `site/content/${out.replace(/\.html$/, ".md")}`
  if (!(await exists(new URL(`../${source}`, import.meta.url).pathname))) {
    sourceless.push(out)
  } else if (!tracked.has(source)) {
    untracked.push(source)
  }
}

for (const { page, href } of broken) console.error(`broken link  ${page} → ${href}`)
for (const { page, href } of anchorsMissing) console.error(`dead anchor  ${page} → ${href}`)
for (const page of sourceless) console.error(`no source    ${page}`)
for (const source of untracked) {
  console.error(`not in git   ${source} — check .gitignore for an unanchored pattern`)
}

if (broken.length || anchorsMissing.length || sourceless.length || untracked.length) {
  console.error(
    `\n${broken.length} broken link(s), ${anchorsMissing.length} dead anchor(s), ` +
      `${sourceless.length} page(s) with no source, ${untracked.length} source(s) not in git`,
  )
  process.exit(1)
}

console.log(
  `checked ${pages.length} page(s), every internal link resolves and every page is in git`,
)
