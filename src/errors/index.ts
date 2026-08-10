import { type HttpError, httpError } from "@atlas/server"

// { statusCode, name, message } — `name` is the machine-readable slug clients
// switch on, and stays stable even when the message is reworded.
export type CorsairErrorName =
  | "missing_required_field"
  | "invalid_parameter"
  | "invalid_access"
  | "validation_error"
  | "not_found"
  | "conflict"
  | "method_not_allowed"
  | "rate_limit_exceeded"
  | "quota_exceeded"
  | "plan_required"
  | "unauthorized"
  | "forbidden"
  | "application_error"

const err = (
  status: number,
  name: CorsairErrorName,
  message: string,
  headers?: Record<string, string>,
) => httpError(status, message, { code: name, headers })

export const missingRequiredField = (message: string) => err(422, "missing_required_field", message)

export const validationError = (message: string) => err(400, "validation_error", message)

export const invalidParameter = (message: string) => err(400, "invalid_parameter", message)

export const notFound = (message = "The requested resource was not found.") =>
  err(404, "not_found", message)

export const conflict = (message: string) => err(409, "conflict", message)

export const methodNotAllowed = () =>
  err(405, "method_not_allowed", "This endpoint does not support that HTTP method.")

export const unauthorized = (message = "You must be signed in to perform this action.") =>
  err(401, "unauthorized", message)

export const forbidden = (message = "You do not have access to that resource.") =>
  err(403, "forbidden", message)

/**
 * The feature exists but the account's plan does not include it. Distinct from
 * a 403 so the panel can render an upgrade prompt rather than an error, which
 * is what every plan-gated screen does.
 */
export const planRequired = (feature: string) =>
  err(402, "plan_required", `Your current plan does not include ${feature}.`)

export const quotaExceeded = (message: string) => err(413, "quota_exceeded", message)

export const rateLimitExceeded = (retryAfterSeconds: number, limit: number) =>
  err(
    429,
    "rate_limit_exceeded",
    "Too many requests. Please limit the number of requests per second.",
    {
      "retry-after": String(retryAfterSeconds),
      "ratelimit-limit": String(limit),
      "ratelimit-remaining": "0",
      "ratelimit-reset": String(retryAfterSeconds),
    },
  )

export const applicationError = (message = "Something went wrong.") =>
  err(500, "application_error", message)

export const errorBody = (e: HttpError): { statusCode: number; name: string; message: string } => ({
  statusCode: e.status,
  name: (e.code as string) ?? "application_error",
  message: e.message,
})
