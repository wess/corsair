import { safeEqual } from "../../auth/index.ts"
import { CONTENT_TYPE, registry } from "../index.ts"

/**
 * `GET /metrics`. Off unless `METRICS_TOKEN` is set, and then a bearer token
 * only: unconfigured falls through to the ordinary 404 so the path does not
 * advertise itself, and a wrong or missing token is a 401. The variable is read
 * per request so a rotated secret takes effect without a restart.
 *
 * Loopback is deliberately not a shortcut. Behind a reverse proxy every request
 * arrives from 127.0.0.1, so the address alone would make the endpoint public.
 */
export const metricsResponse = async (req: Request): Promise<Response | null> => {
  if (new URL(req.url).pathname !== "/metrics") return null
  const token = process.env.METRICS_TOKEN
  if (!token || req.method !== "GET") return null

  const presented = /^Bearer (.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? ""
  if (!safeEqual(presented, token)) {
    return new Response("Unauthorized\n", {
      status: 401,
      headers: { "www-authenticate": 'Bearer realm="metrics"', "content-type": "text/plain" },
    })
  }
  return new Response(await registry.render(), { headers: { "content-type": CONTENT_TYPE } })
}
