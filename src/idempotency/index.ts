import { createHash } from "node:crypto"
import { from } from "@atlas/db"
import { db } from "../db/index.ts"
import {
  concurrentIdempotentRequests,
  invalidIdempotencyKey,
  invalidIdempotentRequest,
} from "../errors/index.ts"
import { type IdempotencyKey, idempotencyKeys } from "../schema/index.ts"

/**
 * `Idempotency-Key` for the sending API, with Resend's semantics.
 *
 * An application that times out waiting for a send does not know whether the
 * mail went, and retrying without a key sends it twice. With one, a repeat of a
 * finished request replays its response, a repeat that arrives while the first
 * is still running gets 409, and a repeat with a different body gets 409 too —
 * reusing a key for a different message is a bug the caller needs to hear about.
 */

const TTL_HOURS = 24
const MAX_LENGTH = 256

const hashRequest = (body: unknown): string =>
  createHash("sha256")
    .update(JSON.stringify(body ?? null))
    .digest("hex")

/**
 * Runs `work` at most once per (account, key) inside the window, and answers
 * with whatever the first run answered.
 */
export const withIdempotency = async (
  userId: string,
  key: string | null,
  body: unknown,
  work: () => Promise<unknown>,
): Promise<{ status: number; body: unknown }> => {
  if (key === null) return { status: 200, body: await work() }
  if (!key.length || key.length > MAX_LENGTH) {
    throw invalidIdempotencyKey(
      `\`Idempotency-Key\` must be between 1 and ${MAX_LENGTH} characters.`,
    )
  }

  const hash = hashRequest(body)

  // An expired row frees its key for reuse.
  await db().execute({
    text: "DELETE FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND expires_at < now()",
    values: [userId, key],
  })

  // The unique index is the lock. Two concurrent first requests cannot both
  // insert, so exactly one of them runs.
  const claimed = await db().all<IdempotencyKey>({
    text: `INSERT INTO idempotency_keys (user_id, key, request_hash, expires_at)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, key) DO NOTHING
           RETURNING *`,
    values: [userId, key, hash, new Date(Date.now() + TTL_HOURS * 3_600_000)],
  })

  if (!claimed.length) {
    const existing = await db().one<IdempotencyKey>(
      from(idempotencyKeys).where((q) => [q("user_id").equals(userId), q("key").equals(key)]),
    )
    // Gone between the insert and the read: the first request failed and
    // released it. Say "in progress" rather than guess, and let the caller retry.
    if (!existing || existing.response_status === null) throw concurrentIdempotentRequests()
    if (existing.request_hash !== hash) throw invalidIdempotentRequest()
    return { status: existing.response_status, body: existing.response_body }
  }

  const row = claimed[0]!
  let result: unknown
  try {
    result = await work()
  } catch (e) {
    // A request that failed must not pin its key, or the retry it exists to
    // make safe is refused.
    await db().execute({
      text: "DELETE FROM idempotency_keys WHERE id = $1 AND response_status IS NULL",
      values: [row.id],
    })
    throw e
  }

  await db().execute(
    from(idempotencyKeys)
      .where((q) => q("id").equals(row.id))
      .update({ response_status: 200, response_body: result as never }),
  )
  return { status: 200, body: result }
}
