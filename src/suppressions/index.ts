import { from } from "@atlas/db"
import { db } from "../db/index.ts"
import { suppressions } from "../schema/index.ts"

/**
 * Addresses an account's API sends must not go to again.
 *
 * Applies to the sending API only. A person writing from their mailbox to an
 * address that once bounced an application's receipt is making their own
 * decision, and silently dropping that message would be a mail server lying
 * about what it did.
 *
 * reason: bounce | complaint | manual
 */

export const normalizeRecipient = (address: string): string => address.trim().toLowerCase()

export const isSuppressed = async (userId: string, address: string): Promise<boolean> => {
  const row = await db().one<{ id: string }>(
    from(suppressions)
      .select("id")
      .where((q) => [q("user_id").equals(userId), q("email").equals(normalizeRecipient(address))]),
  )
  return Boolean(row)
}

/**
 * Adds an address. The first reason recorded is kept: a complaint arriving for
 * an address that already bounced does not rewrite why it was suppressed.
 */
export const suppress = async (input: {
  userId: string
  address: string
  reason: "bounce" | "complaint" | "manual"
  detail?: string | null
  emailId?: string | null
}): Promise<boolean> => {
  const rows = await db().all<{ id: string }>({
    text: `INSERT INTO suppressions (user_id, email, reason, detail, email_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (user_id, email) DO NOTHING
           RETURNING id`,
    values: [
      input.userId,
      normalizeRecipient(input.address),
      input.reason,
      input.detail?.slice(0, 500) ?? null,
      input.emailId ?? null,
    ],
  })
  return rows.length > 0
}

export const removeSuppression = async (userId: string, id: string): Promise<boolean> => {
  const rows = await db().all<{ id: string }>({
    text: "DELETE FROM suppressions WHERE id = $1 AND user_id = $2 RETURNING id",
    values: [id, userId],
  })
  return rows.length > 0
}
