/**
 * Ahead-of-time bundle for the control panel and the webmail.
 *
 * These two pages are the only things this process serves that execute
 * JavaScript and render attacker-supplied HTML, so they are the two that most
 * need a Content Security Policy — and they were the only two not getting one.
 *
 * `Bun.serve({ routes })` matches **before** `fetch`, so an `HTMLBundle`
 * registered in `routes` never passes through the `withSecurityHeaders` wrapper
 * around `fetch`. The result was exactly backwards: the JSON API, which renders
 * nothing, came back with a CSP and `frame-ancestors 'none'`, while the webmail
 * came back with neither and could be framed by anyone.
 *
 * Building here and serving the output through `fetch` puts both documents back
 * behind the same wrapper as every other response.
 *
 * It also fixes the asset URLs. Bun resolves a chunk relative to the HTML's
 * position in the output tree and *then* prefixes `publicPath`, so an entry
 * nested at `src/web/index.html` emits `/../../chunk-x.js`. Browsers normalise
 * that away, which is why it worked — but it would break the first time this is
 * served under a sub-path. Giving each entrypoint its own `root` puts its HTML
 * at the top of its own output tree, and the URLs come out as `/chunk-x.js`.
 *
 * `dev.ts` opts back in to Bun's `routes` for hot reload. That is opt-*in* from
 * the development entrypoint rather than opt-*out* from production, so someone
 * running `bun src/start.ts` without setting NODE_ENV still gets the headers.
 */

export type Asset = {
  body: ArrayBuffer
  type: string
  etag: string
  /** Content-hashed filenames can be cached forever; the two HTML shells cannot. */
  immutable: boolean
}

export type ClientBundle = {
  panel: Asset
  webmail: Asset
  /** Hashed chunks, keyed by the absolute path they are requested at. */
  assets: Map<string, Asset>
}

const SRC = new URL("../", import.meta.url).pathname

const etagOf = (body: ArrayBuffer): string => `"${Bun.hash(body).toString(36)}"`

const asset = (body: ArrayBuffer, type: string, immutable: boolean): Asset => ({
  body,
  type,
  etag: etagOf(body),
  immutable,
})

const buildOne = async (dir: string): Promise<{ html: Asset; assets: Map<string, Asset> }> => {
  const root = `${SRC}${dir}`

  const result = await Bun.build({
    entrypoints: [`${root}/index.html`],
    // `root` is what keeps the emitted asset URLs at the top of the tree.
    root,
    publicPath: "/",
    target: "browser",
    minify: true,
    sourcemap: "none",
    // Without this React ships its *development* build: 488 KB instead of
    // 257 KB, plus prop validation and a double render under StrictMode on
    // every update. Bun does not infer it from the server's own NODE_ENV —
    // nothing does — so it has to be stated. This is the browser bundle, and
    // the browser bundle is always a release build; `dev.ts` gets its hot
    // reload from Bun's `routes` instead, not from this path.
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  })

  if (!result.success) {
    throw new Error(`could not bundle src/${dir}:\n${result.logs.map(String).join("\n")}`)
  }

  const assets = new Map<string, Asset>()
  let html: Asset | null = null

  for (const output of result.outputs) {
    const name = output.path.replace(/^\.\//, "")
    const body = await output.arrayBuffer()
    if (name === "index.html") {
      html = asset(body, "text/html;charset=utf-8", false)
      continue
    }
    assets.set(`/${name}`, asset(body, output.type, true))
  }

  if (!html) throw new Error(`src/${dir} produced no index.html`)
  return { html, assets }
}

/**
 * Builds both clients. Called once at startup rather than lazily on the first
 * request, so a broken build fails the process instead of the first person to
 * open the panel.
 */
export const buildClients = async (): Promise<ClientBundle> => {
  const started = performance.now()
  const [web, mail] = await Promise.all([buildOne("web"), buildOne("mail")])

  const assets = new Map<string, Asset>([...web.assets, ...mail.assets])
  const bytes = [...assets.values()].reduce((sum, a) => sum + a.body.byteLength, 0)

  console.log(
    `[corsair] clients     bundled ${assets.size} asset(s), ${Math.round(bytes / 1024)} KB in ${Math.round(performance.now() - started)}ms`,
  )

  return { panel: web.html, webmail: mail.html, assets }
}

/**
 * A conditional response for an asset.
 *
 * Hashed chunks are immutable — the URL changes when the content does — so they
 * are cached for a year and never revalidated. The HTML shells revalidate every
 * time and answer 304 when unchanged, which is what makes a repeat visit cost
 * one small request rather than the whole bundle.
 */
export const assetResponse = (item: Asset, req: Request): Response => {
  if (req.headers.get("if-none-match") === item.etag) {
    return new Response(null, { status: 304, headers: { etag: item.etag } })
  }

  return new Response(item.body, {
    headers: {
      "content-type": item.type,
      etag: item.etag,
      "cache-control": item.immutable
        ? "public, max-age=31536000, immutable"
        : "no-cache, must-revalidate",
    },
  })
}
