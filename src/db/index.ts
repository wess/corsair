import { type Connection, connect } from "@atlas/db"
import { config } from "../config/index.ts"

let shared: Connection | null = null

// One pool per process. The API, the mail listeners, the workers, and the CLI
// all go through this.
export const db = (): Connection => {
  if (!shared)
    shared = connect({ driver: "postgres", url: config.databaseUrl, pool: config.dbPool })
  return shared
}

export const closeDb = async (): Promise<void> => {
  if (!shared) return
  await shared.close()
  shared = null
}

/**
 * Every column of a schema, for `.returning(...)`.
 *
 * @atlas/db types `returning` over the schema's column keys and emits
 * nothing when given none, so there is no `RETURNING *`. Spreading the full key
 * list is the same SQL and keeps the row type intact.
 */
export const allColumns = <C extends Record<string, unknown>>(schema: {
  columns: C
}): (keyof C & string)[] => Object.keys(schema.columns) as (keyof C & string)[]

/**
 * Postgres BIGINT comes back as a JS bigint, which `JSON.stringify` refuses to
 * serialise. Every byte count and IMAP UID in this schema is a bigint, so they
 * pass through here on the way out.
 */
export const num = (v: bigint | number | string | null | undefined): number => {
  if (v === null || v === undefined) return 0
  return typeof v === "bigint" ? Number(v) : Number(v)
}

export type { Connection }
