import { getR, type Route } from "@atlas/server"
import { json } from "@atlas/server"
import * as logs from "../../../logs/index.ts"
import { ownerOnly } from "../../pipes/index.ts"

/**
 * The server's own journal, for the owner.
 *
 * Owner-only, not plan-gated: these lines carry every account's addresses, IP
 * addresses, and delivery outcomes, so this is the one part of the panel where
 * "which customer am I" is the wrong question and "is this the person who runs
 * the machine" is the right one.
 *
 * All validation lives in `src/logs` — the route only carries query parameters
 * across. Keeping it there means the rules cannot be bypassed by a second
 * caller added later.
 */
export const logRoutes: Route[] = [
  /** The sources this instance will talk about, for the picker. */
  getR("/api/logs/sources", { before: ownerOnly, assigns: {} as never }, async (c) =>
    json(c, 200, {
      object: "list",
      data: logs.UNITS.map((u) => ({ key: u.key, label: u.label, unit: u.unit })),
      windows: logs.SINCE,
    }),
  ),

  getR("/api/logs", { before: ownerOnly, assigns: {} as never }, async (c) => {
    const query = (c.query ?? {}) as Record<string, string>
    const result = await logs.read({
      unit: query.unit,
      lines: query.lines,
      since: query.since,
      search: query.q,
      priority: query.priority,
    })
    return json(c, 200, {
      object: "list",
      data: result.entries,
      truncated: result.truncated,
      available: result.available,
      ...(result.reason ? { reason: result.reason } : {}),
    })
  }),
]
