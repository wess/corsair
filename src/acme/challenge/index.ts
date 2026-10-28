/**
 * HTTP-01 responses for orders this process has in flight, and nothing else.
 *
 * Held in memory on purpose: a token is only meaningful while its order is
 * open, and once it is answered or abandoned it is removed. An unknown token is
 * a 404 like any other missing path, so the endpoint tells a scanner nothing.
 */

const PREFIX = "/.well-known/acme-challenge/"

const pending = new Map<string, string>()

export const addChallenge = (token: string, keyAuthorization: string): void => {
  pending.set(token, keyAuthorization)
}

export const removeChallenge = (token: string): void => {
  pending.delete(token)
}

export const isChallengePath = (pathname: string): boolean => pathname.startsWith(PREFIX)

/** Null when the path is not a challenge at all, so the caller can carry on routing. */
export const challengeResponse = (req: Request, pathname: string): Response | null => {
  if (!isChallengePath(pathname)) return null
  const answer =
    req.method === "GET" || req.method === "HEAD"
      ? pending.get(pathname.slice(PREFIX.length))
      : undefined
  if (!answer) return new Response("Not found", { status: 404 })
  return new Response(req.method === "HEAD" ? null : answer, {
    headers: { "content-type": "application/octet-stream", "cache-control": "no-store" },
  })
}

/**
 * The listener for `ACME_HTTP_PORT`. Let's Encrypt validates HTTP-01 on port 80
 * only, and Corsair's HTTP tier is on `PORT`; on an install with nothing else
 * on 80 this is the piece that answers there.
 *
 * It serves the challenge path and redirects everything else to HTTPS. It
 * deliberately does not proxy to the panel: plain HTTP on 80 is not a second
 * way in.
 */
export const startChallengeListener = (port: number, hostname = "0.0.0.0") =>
  Bun.serve({
    port,
    hostname,
    idleTimeout: 10,
    maxRequestBodySize: 1024,
    fetch: (req) => {
      const url = new URL(req.url)
      const challenge = challengeResponse(req, url.pathname)
      if (challenge) return challenge
      return new Response(null, {
        status: 301,
        headers: { location: `https://${url.hostname}${url.pathname}${url.search}` },
      })
    },
  })
