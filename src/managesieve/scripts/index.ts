import { db } from "../../db/index.ts"

/**
 * ManageSieve's view of the `filters` table.
 *
 * A "script" here is exactly a row the panel and `/api/filters` already show,
 * and a mailbox's *active* script is its `addresses.filter_id` — there is no
 * second copy and no flag column of its own. Scripts belong to the account, so
 * every query is keyed on `user_id`; the mailbox only decides which one runs.
 */

export type Script = { id: string; name: string }

export const MAX_SCRIPTS = 100

export const listScripts = (userId: string): Promise<Script[]> =>
  db().all<Script>({
    text: "SELECT id, name FROM filters WHERE user_id = $1 ORDER BY name",
    values: [userId],
  })

export const countScripts = async (userId: string): Promise<number> => {
  const row = await db().one<{ count: number }>({
    text: "SELECT count(*)::int AS count FROM filters WHERE user_id = $1",
    values: [userId],
  })
  return row?.count ?? 0
}

export const findScript = (
  userId: string,
  name: string,
): Promise<(Script & { script: string }) | null> =>
  db().one<Script & { script: string }>({
    text: "SELECT id, name, script FROM filters WHERE user_id = $1 AND name = $2",
    values: [userId, name],
  })

export const activeScriptId = async (addressId: string): Promise<string | null> => {
  const row = await db().one<{ filter_id: string | null }>({
    text: "SELECT filter_id FROM addresses WHERE id = $1",
    values: [addressId],
  })
  return row?.filter_id ?? null
}

/** Insert or replace by name. One statement, so two clients saving at once cannot collide. */
export const saveScript = async (userId: string, name: string, script: string): Promise<void> => {
  await db().execute({
    text: `INSERT INTO filters (user_id, name, script, size) VALUES ($1, $2, $3, $4)
           ON CONFLICT (user_id, name) DO UPDATE
             SET script = EXCLUDED.script, size = EXCLUDED.size,
                 compile_error = NULL, updated_at = now()`,
    values: [userId, name, script, script.length],
  })
}

export const removeScript = async (userId: string, id: string): Promise<void> => {
  // Mailboxes pointing at it fall back to no filter by the foreign key.
  await db().execute({
    text: "DELETE FROM filters WHERE id = $1 AND user_id = $2",
    values: [id, userId],
  })
}

/** False when the new name is already taken. */
export const renameScript = async (userId: string, id: string, name: string): Promise<boolean> => {
  const row = await db().one<{ id: string }>({
    text: `UPDATE filters SET name = $3, updated_at = now()
            WHERE id = $2 AND user_id = $1
              AND NOT EXISTS (SELECT 1 FROM filters WHERE user_id = $1 AND name = $3)
        RETURNING id`,
    values: [userId, id, name],
  })
  return Boolean(row)
}

export const setActive = async (addressId: string, filterId: string | null): Promise<void> => {
  await db().execute({
    text: "UPDATE addresses SET filter_id = $2, updated_at = now() WHERE id = $1",
    values: [addressId, filterId],
  })
}
