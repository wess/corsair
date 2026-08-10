export type ApiError = { statusCode: number; name: string; message: string }

export class RequestError extends Error {
  readonly status: number
  readonly code: string
  constructor(error: ApiError) {
    super(error.message)
    this.name = "RequestError"
    this.status = error.statusCode
    this.code = error.name
  }
  /** A 402 means the plan is the obstacle, not the request. */
  get needsUpgrade(): boolean {
    return this.status === 402
  }
}

// The panel authenticates with the session cookie, so it reaches the same
// endpoints an API client would, with no key to manage.
export const request = async <T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> => {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: init.body !== undefined ? { "content-type": "application/json" } : {},
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })

  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }

  if (!res.ok) {
    const err = parsed as ApiError
    throw new RequestError(
      err?.message
        ? err
        : {
            statusCode: res.status,
            name: "application_error",
            message: `Request failed (${res.status})`,
          },
    )
  }
  return parsed as T
}

export const get = <T>(path: string) => request<T>(path)
export const post = <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body })
export const patch = <T>(path: string, body?: unknown) =>
  request<T>(path, { method: "PATCH", body })
export const put = <T>(path: string, body?: unknown) => request<T>(path, { method: "PUT", body })
export const del = <T>(path: string) => request<T>(path, { method: "DELETE" })

export type Page<T> = {
  object: "list"
  data: T[]
  page: number
  per_page: number
  total: number
  pages: number
}

export const qs = (params: Record<string, string | number | undefined | null>): string => {
  const search = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue
    search.set(k, String(v))
  }
  const value = search.toString()
  return value ? `?${value}` : ""
}

export const formatBytes = (bytes: number): string => {
  if (!bytes) return "0 B"
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

export const formatMoney = (cents: number, currency = "usd"): string =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(
    cents / 100,
  )

export const formatDate = (value: string | null): string =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : "—"

/**
 * A password a customer will paste into a mail client once and never type.
 * Ambiguous characters are excluded because these do get read aloud and copied
 * by hand despite everything.
 */
export const generatePassword = (length = 20): string => {
  const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789!@#%^&*-_="
  const bytes = new Uint32Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")
}
