import { randomBytes } from "node:crypto"
import { from } from "@atlas/db"
import { hashToken } from "../auth/index.ts"
import { allColumns, db } from "../db/index.ts"
import { type ApiKey, apiKeys } from "../schema/index.ts"

/**
 * Credentials for the sending API.
 *
 * A key belongs to a panel account and sends as the domains that account owns.
 * It is a third identity beside the session and the mailbox credential, and it
 * reaches exactly one surface: `/api/emails`. It cannot open the panel, read a
 * mailbox, or manage anything, which is why an application can hold one.
 *
 * Only the SHA-256 of the token is stored, the same as reset tokens. A lost key
 * is replaced, never read back.
 */

export type Permission = "full_access" | "sending_access"

export const TOKEN_PREFIX = "cs_"

export const generateToken = (): string => `${TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`

export const createApiKey = async (input: {
  userId: string
  name: string
  permission: Permission
  domainId?: string | null
}): Promise<{ key: ApiKey; token: string }> => {
  const token = generateToken()
  const key = await db().one<ApiKey>(
    from(apiKeys)
      .insert({
        user_id: input.userId,
        name: input.name,
        permission: input.permission,
        domain_id: input.domainId ?? null,
        token_hash: hashToken(token),
        // Enough to tell two keys apart in a list, far too little to use.
        token_prefix: token.slice(0, TOKEN_PREFIX.length + 6),
      })
      .returning(...allColumns(apiKeys)),
  )
  return { key: key!, token }
}

/**
 * The key a bearer token names, or null. A key whose account is terminated
 * stops working with the account, without anyone having to revoke it.
 */
export const resolveApiKey = async (token: string): Promise<ApiKey | null> => {
  if (!token.startsWith(TOKEN_PREFIX)) return null

  const key = await db().one<ApiKey>({
    text: `SELECT k.* FROM api_keys k JOIN users u ON u.id = k.user_id
            WHERE k.token_hash = $1 AND u.status <> 'terminated'`,
    values: [hashToken(token)],
  })
  if (!key) return null

  // At most once a minute: a busy application should not turn every send into
  // a write to this row.
  if (!key.last_used_at || Date.now() - key.last_used_at.getTime() > 60_000) {
    void db()
      .execute(
        from(apiKeys)
          .where((q) => q("id").equals(key.id))
          .update({ last_used_at: new Date() }),
      )
      .catch(() => {})
  }
  return key
}

export const listApiKeys = (userId: string): Promise<ApiKey[]> =>
  db().all<ApiKey>(
    from(apiKeys)
      .where((q) => q("user_id").equals(userId))
      .orderBy("created_at", "DESC"),
  )

export const deleteApiKey = async (userId: string, id: string): Promise<boolean> => {
  const rows = await db().all<{ id: string }>({
    text: "DELETE FROM api_keys WHERE id = $1 AND user_id = $2 RETURNING id",
    values: [id, userId],
  })
  return rows.length > 0
}
