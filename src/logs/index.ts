import { invalidParameter } from "../errors/index.ts"

/**
 * Reading the machine's own journal, for the owner of the instance.
 *
 * The panel shows the operator what the server is actually saying — a delivery
 * that failed, a listener that did not bind, a certificate that did not reload
 * — without an SSH session. That is the whole feature, and it is one step away
 * from being a remote shell, so the boundaries are drawn narrowly and enforced
 * here rather than in the route:
 *
 *   - **No shell, ever.** `Bun.spawn` takes an argv array. There is no string
 *     for an argument to escape out of, which is the entire class of bug this
 *     avoids rather than tries to filter.
 *   - **Units are a fixed list.** Not a pattern, not a prefix — a whitelist. An
 *     operator cannot ask for a unit that is not on it, so no input reaches
 *     journalctl's `-u` that this file did not write.
 *   - **The search term is escaped to a literal.** `--grep` takes a regular
 *     expression, and handing an attacker-controlled one to a subprocess is
 *     both a hang and a way to read more than intended.
 *   - **Output is redacted.** A crash can print a connection string or an
 *     environment dump, and this endpoint renders straight into a browser.
 */

/** The units this instance is allowed to be asked about. */
export const UNITS = [
  { key: "corsair", unit: "corsair.service", label: "Mail server" },
  { key: "mxfront", unit: "corsair-mxfront.service", label: "STARTTLS terminator" },
  { key: "check", unit: "corsair-check.service", label: "Health checks" },
  { key: "backup", unit: "corsair-backup.service", label: "Backups" },
  { key: "caddy", unit: "caddy.service", label: "Web front end" },
] as const

export type UnitKey = (typeof UNITS)[number]["key"]

export type LogEntry = {
  at: string
  unit: string
  priority: number
  message: string
}

const MAX_LINES = 2000
const DEFAULT_LINES = 300

/**
 * Windows the journal can be asked for.
 *
 * A fixed set rather than free text: `--since` accepts a small language of its
 * own, and there is no reason to expose it when six choices cover the job.
 */
export const SINCE = ["15m", "1h", "6h", "24h", "7d", "all"] as const
export type Since = (typeof SINCE)[number]

const SINCE_ARG: Record<Exclude<Since, "all">, string> = {
  "15m": "-15 min",
  "1h": "-1 hour",
  "6h": "-6 hours",
  "24h": "-24 hours",
  "7d": "-7 days",
}

/**
 * Escapes a search term so journalctl treats it as text.
 *
 * `--grep` is a regular expression. Left unescaped, `.*` reads far more than
 * the operator typed and `(a+)+b` is a hang in a subprocess this server is
 * waiting on.
 */
export const literal = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Removes the things a log line should never have contained.
 *
 * Belt and braces: this codebase does not log credentials, but an unhandled
 * error can print an environment dump or a Postgres URL with its password in
 * it, and this output goes to a browser. Redacting on the way out costs one
 * pass over the text and does not depend on every future log call being
 * careful.
 */
export const redact = (line: string): string =>
  line
    .replace(/(postgres(?:ql)?:\/\/[^:\s]+:)[^@\s]+@/gi, "$1<redacted>@")
    .replace(/\b(password|passwd|secret|token|api[-_]?key|authorization|bearer)\b(\s*[:=]\s*|\s+)(\S+)/gi, "$1$2<redacted>")
    .replace(/\b(whsec_|sk_live_|sk_test_)[A-Za-z0-9]+/g, "$1<redacted>")

export const unitFor = (key: string): string => {
  const found = UNITS.find((u) => u.key === key)
  if (!found) throw invalidParameter(`Unknown log source "${key}".`)
  return found.unit
}

export const clampLines = (raw: unknown): number => {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LINES
  return Math.min(Math.floor(n), MAX_LINES)
}

export type ReadInput = {
  unit?: string
  lines?: unknown
  since?: string
  search?: string
  /** 0–7, syslog severity. Entries at this level and more severe. */
  priority?: unknown
}

export type ReadResult = {
  entries: LogEntry[]
  truncated: boolean
  available: boolean
  reason?: string
}

/**
 * One journal read.
 *
 * Returns `available: false` rather than throwing when the journal cannot be
 * read, because the common cause is a permission the operator can fix — the
 * service account has to be in `systemd-journal` — and a page that explains
 * that is more useful than a 500.
 */
export const read = async (input: ReadInput): Promise<ReadResult> => {
  const unit = unitFor(input.unit ?? "corsair")
  const lines = clampLines(input.lines)
  const since = (SINCE as readonly string[]).includes(input.since ?? "")
    ? (input.since as Since)
    : "1h"

  const argv = ["journalctl", "-u", unit, "-n", String(lines), "-o", "json", "--no-pager"]
  if (since !== "all") argv.push("--since", SINCE_ARG[since])

  const priority = Number(input.priority)
  if (Number.isInteger(priority) && priority >= 0 && priority <= 7) {
    argv.push("-p", String(priority))
  }

  const search = (input.search ?? "").trim().slice(0, 200)
  if (search) argv.push("--grep", literal(search), "--case-sensitive=false")

  let stdout = ""
  let stderr = ""
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
    // A journal read is bounded work, but --grep over a large journal is not
    // instant and this request is holding a connection.
    const timer = setTimeout(() => proc.kill(), 15_000)
    ;[stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    await proc.exited
    clearTimeout(timer)
  } catch (e) {
    return { entries: [], truncated: false, available: false, reason: (e as Error).message }
  }

  if (!stdout.trim()) {
    if (/insufficient permissions|not.*permitted/i.test(stderr)) {
      return {
        entries: [],
        truncated: false,
        available: false,
        reason:
          "This server cannot read its own journal. Add the service account to the systemd-journal group and restart it.",
      }
    }
    return { entries: [], truncated: false, available: true }
  }

  const entries: LogEntry[] = []
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as Record<string, unknown>
      const micros = Number(row.__REALTIME_TIMESTAMP ?? 0)
      // journald's MESSAGE is an array of bytes when it is not valid UTF-8.
      const raw = Array.isArray(row.MESSAGE)
        ? Buffer.from(row.MESSAGE as number[]).toString("utf8")
        : String(row.MESSAGE ?? "")
      entries.push({
        at: new Date(micros / 1000).toISOString(),
        unit: String(row._SYSTEMD_UNIT ?? row.SYSLOG_IDENTIFIER ?? unit),
        priority: Number(row.PRIORITY ?? 6),
        message: redact(raw),
      })
    } catch {
      // A line journald wrote that is not JSON is not worth failing the page
      // over; the rest of the read is still useful.
    }
  }

  return { entries, truncated: entries.length >= lines, available: true }
}
