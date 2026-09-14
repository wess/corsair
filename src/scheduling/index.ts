import { invalidParameter } from "../errors/index.ts"

/**
 * `scheduled_at` for the sending API.
 *
 * Accepts ISO 8601 and the natural-language offsets Resend documents (`in 1
 * min`, `in 2 hours`, `tomorrow`), because clients written against Resend send
 * both and a schedule that is refused is a message that is never sent.
 */

const UNITS: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: 86400,
  day: 86400,
  days: 86400,
  w: 604800,
  week: 604800,
  weeks: 604800,
}

const RELATIVE = /^in\s+(\d+(?:\.\d+)?)\s*([a-z]+)$/i
const BARE = /^(\d+(?:\.\d+)?)\s*([a-z]+)\s*(?:from\s+now)?$/i

/**
 * How far ahead a send may be scheduled. The queued body waits in storage the
 * whole time, and a message held for a year is not transactional mail.
 */
export const MAX_SCHEDULE_DAYS = 30

export const parseScheduledAt = (
  input: string | null | undefined,
  now: Date = new Date(),
): Date | null => {
  if (input === null || input === undefined || input === "") return null
  const value = String(input).trim()
  const lower = value.toLowerCase()

  if (lower === "now") return new Date(now)
  if (lower === "tomorrow") return new Date(now.getTime() + 86_400_000)

  const relative = value.match(RELATIVE) ?? value.match(BARE)
  if (relative) {
    const amount = Number(relative[1])
    const unit = UNITS[(relative[2] ?? "").toLowerCase()]
    if (unit && Number.isFinite(amount)) return new Date(now.getTime() + amount * unit * 1000)
  }

  // Only a string that looks like a date. `new Date("5")` is a valid date in
  // the year 2005, which is not what anyone sending "5" meant.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed
  }

  throw invalidParameter(
    "`scheduled_at` must be an ISO 8601 date or a natural language offset such as `in 1 min`.",
  )
}

/**
 * A time in the past sends now rather than failing: a client's clock a few
 * seconds behind ours is not a reason to refuse its mail. A time too far ahead
 * is refused, since holding it is not a promise this queue makes.
 */
export const normalizeSchedule = (at: Date | null, now: Date = new Date()): Date | null => {
  if (!at || at.getTime() <= now.getTime()) return null
  if (at.getTime() - now.getTime() > MAX_SCHEDULE_DAYS * 86_400_000) {
    throw invalidParameter(`\`scheduled_at\` can be at most ${MAX_SCHEDULE_DAYS} days ahead.`)
  }
  return at
}
