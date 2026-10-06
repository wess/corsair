import { config } from "../config/index.ts"
import { errorBody, forbidden } from "../errors/index.ts"

export const checkOrigin = (req: Request): Response | null => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return null
  const site = req.headers.get("sec-fetch-site")
  const origin = req.headers.get("origin")
  const url = new URL(req.url)
  const protocol = config.publicUrl.startsWith("https://") ? "https:" : url.protocol
  const expected = new URL(`${protocol}//${url.host}`).origin
  if ((site && site !== "same-origin" && site !== "none") || (origin && origin !== expected)) {
    return new Response(
      JSON.stringify(errorBody(forbidden("Use this site's own page to make changes."))),
      {
        status: 403,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      },
    )
  }
  return null
}

export const privateResponse = (req: Request, res: Response): Response => {
  const path = new URL(req.url).pathname
  if (!path.startsWith("/api/") && !path.startsWith("/jmap") && path !== "/.well-known/jmap")
    return res
  const headers = new Headers(res.headers)
  headers.set("cache-control", "no-store")
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers })
}
