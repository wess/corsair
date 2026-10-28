import { db } from "../db/index.ts"
import { emit } from "../events/index.ts"
import { sendQuotaWarning } from "../notify/index.ts"
import { formatBytes, usageOf } from "../plans/index.ts"
import type { User } from "../schema/index.ts"

/**
 * Tells an account's owner when its storage crosses a line, once per crossing.
 *
 * `quota.warning` at 90% and `quota.exceeded` when full are emitted on the way
 * up only. Freeing space moves the state back down silently, so the next climb
 * is announced again, but nobody is told twice about the same one. The UPDATE
 * that moves `users.storage_state` is the claim: two deliveries racing past the
 * line both run this, and only the one whose UPDATE changed the row speaks.
 */

export type StorageState = "ok" | "warning" | "exceeded"

export const WARN_AT = 0.9

const RANK: Record<StorageState, number> = { ok: 0, warning: 1, exceeded: 2 }

export const stateFor = (used: number, limit: number): StorageState => {
  if (limit <= 0 || limit >= Number.MAX_SAFE_INTEGER) return "ok"
  if (used >= limit) return "exceeded"
  if (used >= limit * WARN_AT) return "warning"
  return "ok"
}

/**
 * Re-reads the account's usage and moves its state. `incoming` counts a message
 * that was just refused for lack of room, so an account that is 99% full and
 * turning mail away reads as exceeded even though what is stored still fits.
 */
export const updateStorageState = async (
  userId: string,
  incoming = 0,
): Promise<StorageState | null> => {
  try {
    const usage = await usageOf(userId)
    const next = stateFor(usage.bytesUsed + incoming, usage.storageBytes)

    const moved = await db().one<User & { before: StorageState }>({
      text: `UPDATE users u SET storage_state = $2
               FROM (SELECT id, storage_state AS before FROM users WHERE id = $1 FOR UPDATE) o
              WHERE u.id = o.id AND o.before <> $2
          RETURNING u.*, o.before`,
      values: [userId, next],
    })
    if (!moved || RANK[next] <= RANK[moved.before]) return next

    const used = formatBytes(usage.bytesUsed)
    const limit = formatBytes(usage.storageBytes)
    void emit({
      userId,
      type: next === "exceeded" ? "quota.exceeded" : "quota.warning",
      data: {
        bytes_used: usage.bytesUsed,
        storage_bytes: usage.storageBytes,
        percent: Math.min(100, Math.round((usage.bytesUsed / usage.storageBytes) * 100)),
      },
    })
    await sendQuotaWarning(moved, used, limit, next === "exceeded").catch((e: unknown) =>
      console.error("[corsair] storage notice failed:", (e as Error).message),
    )
    return next
  } catch (e) {
    // Called from the delivery path. Losing a notice must not fail the mail.
    console.error("[corsair] storage state check failed:", (e as Error).message)
    return null
  }
}
