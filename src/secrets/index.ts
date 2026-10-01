/**
 * Refuses a signing secret nobody should be running with.
 *
 * `JWT_SECRET` signs panel and webmail sessions, keys the SRS HMAC that stops a
 * forwarding address being an open relay, and (hashed) encrypts stored transfer
 * credentials. The shipped defaults are published in the repository, so a server
 * started with one has handed all three to anyone who can read it.
 */

const SHIPPED = ["corsair-dev-secret-change-me", "change-me-to-a-long-random-string"]
const MIN_LENGTH = 32

/** What is wrong with the secret, or null when it is acceptable. */
export const secretProblem = (secret: string): string | null => {
  if (SHIPPED.includes(secret) || secret.includes("change-me")) {
    return "JWT_SECRET is still a value from the repository."
  }
  if (secret.length < MIN_LENGTH) {
    return `JWT_SECRET is ${secret.length} characters; it needs at least ${MIN_LENGTH}.`
  }
  return null
}

export const assertSecret = (secret: string): void => {
  const problem = secretProblem(secret)
  if (problem) {
    throw new Error(`${problem} Generate one with: openssl rand -base64 48`)
  }
}
