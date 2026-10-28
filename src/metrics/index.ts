import pkg from "../../package.json" with { type: "json" }
import { db } from "../db/index.ts"

/**
 * A small in-process metrics registry and the Prometheus text exposition
 * (format 0.0.4) for it. Process-local: a restart resets every counter, which
 * is what `rate()` and `increase()` expect, and nothing here is persisted.
 *
 * Labels are the only way this goes wrong. Every label value in this codebase
 * comes from a closed set (a listener name, a protocol, a reason class), never
 * from an address, a domain or an IP — one series per sender would be an
 * unbounded map in memory and a scrape that grows without limit. `SERIES_CAP`
 * is the backstop: a metric past it drops new label sets rather than growing.
 */

export type Labels = Record<string, string>

const SERIES_CAP = 500

type Series<T> = Map<string, { labels: Labels; value: T }>

const keyOf = (names: readonly string[], labels: Labels): string =>
  names.map((n) => labels[n] ?? "").join("\u0000")

const labelsOf = (names: readonly string[], labels: Labels): Labels => {
  const out: Labels = {}
  for (const n of names) out[n] = labels[n] ?? ""
  return out
}

/** Backslash, double quote and newline are the three characters the format escapes in a label value. */
export const escapeLabel = (v: string): string =>
  v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")

const escapeHelp = (v: string): string => v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")

const fmt = (n: number): string => {
  if (Number.isNaN(n)) return "NaN"
  if (n === Number.POSITIVE_INFINITY) return "+Inf"
  if (n === Number.NEGATIVE_INFINITY) return "-Inf"
  return String(n)
}

const renderLabels = (labels: Labels, extra?: Labels): string => {
  const all = { ...labels, ...extra }
  const parts = Object.entries(all).map(([k, v]) => `${k}="${escapeLabel(v)}"`)
  return parts.length ? `{${parts.join(",")}}` : ""
}

type Renderable = { name: string; render: () => string[] }

const head = (name: string, help: string, type: string): string[] => [
  `# HELP ${name} ${escapeHelp(help)}`,
  `# TYPE ${name} ${type}`,
]

export type Counter = { inc: (labels?: Labels, by?: number) => void }
export type Gauge = {
  set: (labels: Labels | undefined, value: number) => void
  inc: (labels?: Labels, by?: number) => void
  dec: (labels?: Labels, by?: number) => void
  reset: () => void
}
export type Histogram = { observe: (labels: Labels | undefined, value: number) => void }

export const createRegistry = () => {
  const metrics: Renderable[] = []
  const collectors: (() => void | Promise<void>)[] = []

  const add = (m: Renderable) => {
    if (metrics.some((x) => x.name === m.name))
      throw new Error(`metric ${m.name} is registered twice`)
    metrics.push(m)
  }

  const counter = (name: string, help: string, names: readonly string[] = []): Counter => {
    const series: Series<number> = new Map()
    add({
      name,
      render: () => [
        ...head(name, help, "counter"),
        ...[...series.values()].map((s) => `${name}${renderLabels(s.labels)} ${fmt(s.value)}`),
      ],
    })
    return {
      inc: (labels = {}, by = 1) => {
        const key = keyOf(names, labels)
        const s = series.get(key)
        if (s) s.value += by
        else if (series.size < SERIES_CAP)
          series.set(key, { labels: labelsOf(names, labels), value: by })
      },
    }
  }

  const gauge = (name: string, help: string, names: readonly string[] = []): Gauge => {
    const series: Series<number> = new Map()
    add({
      name,
      render: () => [
        ...head(name, help, "gauge"),
        ...[...series.values()].map((s) => `${name}${renderLabels(s.labels)} ${fmt(s.value)}`),
      ],
    })
    const change = (labels: Labels, by: number, replace: boolean) => {
      const key = keyOf(names, labels)
      const s = series.get(key)
      if (s) s.value = replace ? by : s.value + by
      else if (series.size < SERIES_CAP)
        series.set(key, { labels: labelsOf(names, labels), value: by })
    }
    return {
      set: (labels = {}, value) => change(labels, value, true),
      inc: (labels = {}, by = 1) => change(labels, by, false),
      dec: (labels = {}, by = 1) => change(labels, -by, false),
      reset: () => series.clear(),
    }
  }

  const histogram = (
    name: string,
    help: string,
    buckets: readonly number[],
    names: readonly string[] = [],
  ): Histogram => {
    const bounds = [...buckets].sort((a, b) => a - b)
    type H = { counts: number[]; sum: number; count: number }
    const series: Series<H> = new Map()
    add({
      name,
      render: () => {
        const lines = head(name, help, "histogram")
        for (const s of series.values()) {
          // Stored per bucket, exposed cumulatively: `le` means "at most".
          let running = 0
          bounds.forEach((b, i) => {
            running += s.value.counts[i] ?? 0
            lines.push(`${name}_bucket${renderLabels(s.labels, { le: fmt(b) })} ${running}`)
          })
          lines.push(`${name}_bucket${renderLabels(s.labels, { le: "+Inf" })} ${s.value.count}`)
          lines.push(`${name}_sum${renderLabels(s.labels)} ${fmt(s.value.sum)}`)
          lines.push(`${name}_count${renderLabels(s.labels)} ${s.value.count}`)
        }
        return lines
      },
    })
    return {
      observe: (labels = {}, value) => {
        const key = keyOf(names, labels)
        let s = series.get(key)
        if (!s) {
          if (series.size >= SERIES_CAP) return
          s = {
            labels: labelsOf(names, labels),
            value: { counts: new Array(bounds.length).fill(0), sum: 0, count: 0 },
          }
          series.set(key, s)
        }
        const i = bounds.findIndex((b) => value <= b)
        if (i !== -1) s.value.counts[i] = (s.value.counts[i] ?? 0) + 1
        s.value.sum += value
        s.value.count++
      },
    }
  }

  /** Runs just before every render; for gauges that are read from somewhere else. */
  const collect = (fn: () => void | Promise<void>) => {
    collectors.push(fn)
  }

  const render = async (): Promise<string> => {
    for (const fn of collectors) await Promise.resolve(fn()).catch(() => {})
    return `${metrics.flatMap((m) => m.render()).join("\n")}\n`
  }

  return { counter, gauge, histogram, collect, render }
}

export const registry = createRegistry()
export const CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"

// Closed label sets. Anything outside them lands in "other".

const pick = (set: readonly string[], value: string | undefined): string =>
  set.includes(value ?? "") ? (value as string) : "other"

const PROTOCOLS = ["smtp", "imap", "pop3", "jmap", "panel", "webmail"]
const IMAP_COMMANDS = [
  "CAPABILITY",
  "NOOP",
  "LOGOUT",
  "ID",
  "ENABLE",
  "STARTTLS",
  "LOGIN",
  "AUTHENTICATE",
  "SELECT",
  "EXAMINE",
  "CREATE",
  "DELETE",
  "RENAME",
  "SUBSCRIBE",
  "UNSUBSCRIBE",
  "LIST",
  "LSUB",
  "STATUS",
  "APPEND",
  "NAMESPACE",
  "IDLE",
  "UNSELECT",
  "CLOSE",
  "CHECK",
  "EXPUNGE",
  "SEARCH",
  "SORT",
  "FETCH",
  "STORE",
  "COPY",
  "MOVE",
  "UID",
]
const POP3_COMMANDS = [
  "CAPA",
  "USER",
  "PASS",
  "AUTH",
  "STLS",
  "STAT",
  "LIST",
  "UIDL",
  "RETR",
  "TOP",
  "DELE",
  "NOOP",
  "RSET",
  "QUIT",
]
const SMTP_COMMANDS = [
  "EHLO",
  "HELO",
  "STARTTLS",
  "AUTH",
  "MAIL",
  "RCPT",
  "DATA",
  "RSET",
  "NOOP",
  "QUIT",
  "VRFY",
  "EXPN",
  "HELP",
  "XCLIENT",
]
const JMAP_METHOD =
  /^(Core\/echo|(Mailbox|Email|Thread|Identity|EmailSubmission|SearchSnippet|VacationResponse)\/(get|set|query|changes|queryChanges|copy|parse))$/

/** The command name as a label value: a known one verbatim, anything else "other". */
export const commandName = (protocol: "imap" | "pop3" | "smtp" | "jmap", name: string): string => {
  if (protocol === "jmap") return JMAP_METHOD.test(name) ? name : "other"
  const upper = name.toUpperCase()
  if (protocol === "imap") return pick(IMAP_COMMANDS, upper)
  if (protocol === "pop3") return pick(POP3_COMMANDS, upper)
  return pick(SMTP_COMMANDS, upper)
}

/** Why an SMTP reply refused a message, as one of a handful of classes. */
export const smtpReason = (reply: { code: number; enhanced?: string; message: string }): string => {
  const text = reply.message.toLowerCase()
  if (reply.code === 552 || reply.enhanced === "5.3.4" || /exceeds|too large|size limit/.test(text))
    return "size"
  if (/spam|junk/.test(text)) return "spam"
  if (reply.code === 535 || reply.code === 530 || /\b(spf|dkim|dmarc)\b|authentication/.test(text))
    return "auth"
  if (
    /^[45]\.7\./.test(reply.enhanced ?? "") ||
    /relay|limit|loop|blocked|denied|policy/.test(text)
  )
    return "policy"
  return "other"
}

/** Why a delivery attempt was deferred. Blocklist first: it arrives as a 4xx or a 5xx. */
export const deferralReason = (code: number | null, message: string): string => {
  const text = message.toLowerCase()
  if (/block ?list|spamhaus|dnsbl|rbl|blocked using/.test(text)) return "blocklist"
  if (/tls|starttls|certificate|handshake/.test(text)) return "tls"
  if (/connect|timed out|timeout|refused|unreachable|reset|resolve|no mx|dns|econn/.test(text))
    return "connect"
  if (code !== null && code >= 400 && code < 500) return "4xx"
  return "other"
}

// Instruments.

export const smtpSessions = registry.counter(
  "corsair_smtp_sessions_total",
  "SMTP connections accepted, by listener.",
  ["listener"],
)
export const smtpMessages = registry.counter(
  "corsair_smtp_messages_total",
  "Messages finished at DATA, by listener, result and refusal class.",
  ["listener", "result", "reason"],
)
export const smtpRecipientsRejected = registry.counter(
  "corsair_smtp_recipients_rejected_total",
  "RCPT TO commands refused, by listener and class.",
  ["listener", "reason"],
)
export const smtpMessageBytes = registry.histogram(
  "corsair_smtp_message_size_bytes",
  "Size of messages received at DATA.",
  [1_024, 10_240, 102_400, 1_048_576, 5_242_880, 10_485_760, 26_214_400],
  ["listener"],
)

export const deliveryAttempts = registry.counter(
  "corsair_delivery_attempts_total",
  "Outbound delivery attempts by outcome.",
  ["outcome"],
)
export const deliveryDeferrals = registry.counter(
  "corsair_delivery_deferrals_total",
  "Outbound deferrals by reason class.",
  ["reason"],
)
const queueDepth = registry.gauge(
  "corsair_queue_depth",
  "Outbound deliveries waiting or in flight, by status.",
  ["status"],
)
const queueOldest = registry.gauge(
  "corsair_queue_oldest_age_seconds",
  "Age of the oldest delivery that is still queued or deferred.",
)
const queueOverdue = registry.gauge(
  "corsair_queue_overdue_age_seconds",
  "How long the longest-waiting due delivery has been due; grows when the worker is not keeping up.",
)

export const authAttempts = registry.counter(
  "corsair_auth_attempts_total",
  "Login attempts by protocol and result.",
  ["protocol", "result"],
)
const bansActive = registry.gauge("corsair_bans_active", "IP addresses currently banned.")

export const connections = registry.gauge(
  "corsair_connections_active",
  "Open client connections, by protocol.",
  ["protocol"],
)
export const commands = registry.counter(
  "corsair_commands_total",
  'Protocol commands handled; unknown names are folded into "other".',
  ["protocol", "command"],
)

export const webhookDeliveries = registry.counter(
  "corsair_webhook_deliveries_total",
  "Webhook delivery attempts by outcome (delivered, failed, exhausted).",
  ["outcome"],
)
export const storageErrors = registry.counter(
  "corsair_storage_errors_total",
  "Object store failures by operation.",
  ["op"],
)

const startedAt = Date.now()
const uptime = registry.gauge(
  "corsair_process_uptime_seconds",
  "Seconds since this process started.",
)
const rss = registry.gauge("corsair_process_resident_memory_bytes", "Resident set size.")
const heap = registry.gauge("corsair_process_heap_used_bytes", "JS heap in use.")
const buildInfo = registry.gauge("corsair_build_info", "Always 1; the version is the label.", [
  "version",
])
export const loopLag = registry.histogram(
  "corsair_event_loop_lag_seconds",
  "How late a 500 ms timer fired.",
  [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 5],
)

export const authResult = (protocol: string, result: "ok" | "fail" | "banned"): void =>
  authAttempts.inc({ protocol: pick(PROTOCOLS, protocol), result })

registry.collect(() => {
  uptime.set(undefined, (Date.now() - startedAt) / 1000)
  const mem = process.memoryUsage()
  rss.set(undefined, mem.rss)
  heap.set(undefined, mem.heapUsed)
})

buildInfo.set({ version: pkg.version }, 1)

let lagTimer: ReturnType<typeof setInterval> | null = null

/** Samples event-loop lag as the drift of a 500 ms interval. Idempotent. */
export const startProcessMetrics = (): void => {
  if (lagTimer) return
  let last = performance.now()
  lagTimer = setInterval(() => {
    const now = performance.now()
    loopLag.observe(undefined, Math.max(0, now - last - 500) / 1000)
    last = now
  }, 500)
  lagTimer.unref()
}

// Database-backed gauges are read at scrape time, two queries, cached for a few
// seconds so several Prometheus replicas (or a curious operator) cannot turn
// /metrics into load. A slow database keeps the last values for that scrape
// rather than failing the whole response.
const CACHE_MS = 5_000
const DB_DEADLINE_MS = 2_000
let cachedAt = 0

type QueueRow = { status: string; count: string; oldest: string | null; overdue: string | null }

registry.collect(async () => {
  if (Date.now() - cachedAt < CACHE_MS) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("metrics query timed out")), DB_DEADLINE_MS)
  })
  try {
    const [rows, bans] = await Promise.race([
      Promise.all([
        db().all<QueueRow>({
          text: `SELECT status, count(*)::text AS count,
                        extract(epoch FROM now() - min(created_at))::text AS oldest,
                        extract(epoch FROM now() - min(run_at) FILTER (WHERE run_at <= now()))::text AS overdue
                   FROM deliveries
                  WHERE status IN ('queued', 'deferred', 'sending')
                  GROUP BY status`,
          values: [],
        }),
        db().one<{ count: string }>({
          text: "SELECT count(*)::text AS count FROM bans WHERE expires_at > now()",
          values: [],
        }),
      ]),
      deadline,
    ])
    queueDepth.reset()
    for (const status of ["queued", "deferred", "sending"]) queueDepth.set({ status }, 0)
    let oldest = 0
    let overdue = 0
    for (const r of rows) {
      queueDepth.set({ status: r.status }, Number(r.count))
      if (r.status !== "sending") {
        oldest = Math.max(oldest, Number(r.oldest ?? 0))
        overdue = Math.max(overdue, Number(r.overdue ?? 0))
      }
    }
    queueOldest.set(undefined, oldest)
    queueOverdue.set(undefined, overdue)
    bansActive.set(undefined, Number(bans?.count ?? 0))
    cachedAt = Date.now()
  } catch {
    // Keep the last known values; the process metrics still render.
  } finally {
    clearTimeout(timer)
  }
})
