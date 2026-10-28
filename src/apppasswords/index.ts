import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { from } from "@wess/atlas/db/query"
import { allColumns, db } from "../db/index.ts"
import { conflict, invalidParameter } from "../errors/index.ts"
import { type Address, type AppPassword, appPasswords } from "../schema/index.ts"

/**
 * App passwords: one random credential per mail client.
 *
 * A mailbox password typed into three devices is one secret in three places,
 * and for an account with two-factor sign-in it is also a way around the second
 * factor, because IMAP and SMTP have nowhere to ask for one. An app password is
 * chosen by the server, opens only the mail protocols named in its scopes, and
 * stops everywhere the moment its row is deleted.
 *
 * Accepted in exactly one place — `authenticateResolved` in `src/auth` — so every
 * protocol that funnels through it gets them, and the webmail (a browser sign-in
 * with the real password) is told not to.
 */

export const APP_PASSWORD_SCOPES = ["imap", "pop3", "smtp", "jmap", "dav", "sieve"] as const
export type AppPasswordScope = (typeof APP_PASSWORD_SCOPES)[number]

/** Who is asking. `webmail` never accepts an app password; see `authenticateResolved`. */
export type MailVia = AppPasswordScope | "webmail"

/**
 * Lowercase letters and digits with `l`, `o`, `0` and `1` taken out: nothing to
 * misread off a laptop screen while typing into a phone, no shift key, and
 * exactly 32 symbols so one random byte masked to five bits is uniform.
 */
const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
const LENGTH = 20
const SHAPE = /^[a-kmnp-z2-9]{20}$/

/**
 * Twenty symbols of five bits is 100 bits. Online guessing is already bounded by
 * the listeners' failure bans; the margin is for the offline case, where the
 * stored SHA-256 leaks and nothing slows a guesser down. 2^100 SHA-256 evaluations
 * is out of reach, where the 80 bits of a four-group code would be a large but
 * finite bill. Five groups of four is still something a person types once.
 */
export const generateAppPassword = (): string => {
  const bytes = randomBytes(LENGTH)
  let out = ""
  for (let i = 0; i < LENGTH; i++) {
    if (i > 0 && i % 4 === 0) out += "-"
    out += ALPHABET[(bytes[i] as number) & 31]
  }
  return out
}

/**
 * The canonical form of whatever was typed, or null when it cannot be one.
 *
 * Dashes and spaces are dropped and case is folded, because a phone keyboard
 * capitalises the first letter and people copy the groups with or without the
 * separators. Anything that is not then twenty symbols of the alphabet is an
 * ordinary password and never costs a query.
 */
export const normalizeAppPassword = (presented: string): string | null => {
  const folded = presented.toLowerCase().replace(/[\s-]/g, "")
  return SHAPE.test(folded) ? folded : null
}

const digest = (canonical: string): string => createHash("sha256").update(canonical).digest("hex")

/** Bounds the constant-time scan in `matchAppPassword`, which reads every row for the mailbox. */
export const MAX_APP_PASSWORDS = 50

export const createAppPassword = async (input: {
  address: Address
  name: string
  scopes?: readonly AppPasswordScope[]
}): Promise<{ appPassword: AppPassword; password: string }> => {
  // An agent already holds a revocable token, and a forwarding address has
  // nothing to sign into.
  if (input.address.type !== "standard" && input.address.type !== "catchall") {
    throw invalidParameter("Only a mailbox that people sign into can have app passwords.")
  }
  const name = input.name.trim()
  if (!name) throw invalidParameter("Give the app password a name, like the device it is for.")

  const scopes = APP_PASSWORD_SCOPES.filter((s) =>
    (input.scopes ?? APP_PASSWORD_SCOPES).includes(s),
  )
  if (scopes.length === 0) throw invalidParameter("Choose at least one protocol.")

  const row = await db().one<{ count: string }>({
    text: "SELECT count(*)::text AS count FROM app_passwords WHERE address_id = $1",
    values: [input.address.id],
  })
  if (Number(row?.count ?? 0) >= MAX_APP_PASSWORDS) {
    throw conflict(`A mailbox can have at most ${MAX_APP_PASSWORDS} app passwords.`)
  }

  const password = generateAppPassword()
  const appPassword = (await db().one<AppPassword>(
    from(appPasswords)
      .insert({
        address_id: input.address.id,
        name,
        token_hash: digest(normalizeAppPassword(password)!),
        scopes,
      })
      .returning(...allColumns(appPasswords)),
  ))!
  return { appPassword, password }
}

export const listAppPasswords = (addressId: string): Promise<AppPassword[]> =>
  db().all<AppPassword>({
    text: "SELECT * FROM app_passwords WHERE address_id = $1 ORDER BY created_at DESC",
    values: [addressId],
  })

/** Scoped by address in the query, so another mailbox's id is simply not found. */
export const deleteAppPassword = async (addressId: string, id: string): Promise<boolean> => {
  const row = await db().one<{ id: string }>({
    text: "DELETE FROM app_passwords WHERE id = $1 AND address_id = $2 RETURNING id",
    values: [id, addressId],
  })
  return Boolean(row)
}

/**
 * The app password this secret is, among the mailbox's own, or null.
 *
 * Every row is compared, in constant time, with no early exit: the time taken
 * says how many app passwords the mailbox has, never which one came close.
 */
export const matchAppPassword = async (
  addressId: string,
  presented: string,
): Promise<AppPassword | null> => {
  const canonical = normalizeAppPassword(presented)
  if (!canonical) return null

  const rows = await db().all<AppPassword>({
    text: "SELECT * FROM app_passwords WHERE address_id = $1",
    values: [addressId],
  })
  const given = Buffer.from(digest(canonical), "hex")
  let found: AppPassword | null = null
  for (const row of rows) {
    const expected = Buffer.from(row.token_hash, "hex")
    if (expected.length === given.length && timingSafeEqual(given, expected)) found = row
  }
  return found
}

/**
 * Whether an app password with these scopes opens this protocol.
 *
 * A caller that does not say which protocol it is gets in only with an app
 * password that opens everything, so a listener added later fails closed
 * against a restricted one rather than open.
 */
export const scopeAllows = (scopes: readonly string[], via: MailVia | undefined): boolean => {
  if (via === "webmail") return false
  if (via === undefined) return APP_PASSWORD_SCOPES.every((s) => scopes.includes(s))
  return scopes.includes(via)
}

/** Fire and forget: a failure to note the use must not fail the login. */
export const recordAppPasswordUse = (id: string, ip: string | undefined): void => {
  void db()
    .execute({
      text: `UPDATE app_passwords SET last_used_at = now(), last_used_ip = $2
              WHERE id = $1
                AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute'
                     OR last_used_ip IS DISTINCT FROM $2)`,
      values: [id, ip ?? null],
    })
    .catch(() => {})
}
