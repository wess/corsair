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
  // The sending API answers with Resend's names, so a client written against
  // Resend can switch on them unchanged.
  | "missing_api_key"
  | "invalid_api_key"
  | "restricted_api_key"
  | "invalid_from_address"
  | "invalid_attachment"
  | "invalid_idempotency_key"
  | "invalid_idempotent_request"
  | "concurrent_idempotent_requests"
  | "daily_quota_exceeded"

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

// sending

export const missingApiKey = () =>
  err(
    401,
    "missing_api_key",
    "Missing API key in the authorization header. Send it as `Authorization: Bearer <key>`.",
  )

export const invalidApiKey = () => err(403, "invalid_api_key", "API key is invalid.")

export const restrictedApiKey = () =>
  err(
    401,
    "restricted_api_key",
    "This API key is restricted to only send emails. Use a full access key for this operation.",
  )

export const invalidFromAddress = (message: string) => err(422, "invalid_from_address", message)

/**
 * A sender this account may not use. 403 with `validation_error`, which is what
 * Resend answers for an unverified domain, so clients already handle it.
 */
export const senderNotAllowed = (message: string) => err(403, "validation_error", message)

export const invalidAttachment = (message: string) => err(422, "invalid_attachment", message)

export const invalidIdempotencyKey = (message: string) =>
  err(400, "invalid_idempotency_key", message)

export const invalidIdempotentRequest = () =>
  err(
    409,
    "invalid_idempotent_request",
    "Same idempotency key used with a different request payload.",
  )

export const concurrentIdempotentRequests = () =>
  err(
    409,
    "concurrent_idempotent_requests",
    "Same idempotency key used while the original request is still in progress.",
  )

export const dailyQuotaExceeded = (limit: number) =>
  err(
    429,
    "daily_quota_exceeded",
    `You have reached your daily sending quota of ${limit} messages. Try again tomorrow.`,
  )

export const errorBody = (e: HttpError): { statusCode: number; name: string; message: string } => ({
  statusCode: e.status,
  name: (e.code as string) ?? "application_error",
  message: e.message,
})
