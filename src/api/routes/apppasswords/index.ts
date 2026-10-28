import { delR, getR, json, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import {
  APP_PASSWORD_SCOPES,
  createAppPassword,
  deleteAppPassword,
  listAppPasswords,
} from "../../../apppasswords/index.ts"
import { recordAuthFailure, verifyMailboxPassword } from "../../../auth/index.ts"
import { db } from "../../../db/index.ts"
import { notFound, unauthorized } from "../../../errors/index.ts"
import type { Address } from "../../../schema/index.ts"
import { appPasswordObject } from "../../../serialize/index.ts"
import { authed, identityOf, ipOf, mailed, principalOf } from "../../pipes/index.ts"
import { ownedAddress } from "../addresses/index.ts"

/**
 * App passwords, from two sides.
 *
 *   /api/addresses/:address_id/app-passwords   the panel's, for anyone who may
 *                                              manage the mailbox (`ownedAddress`)
 *   /api/mail/app-passwords                    the mailbox holder's own, from the
 *                                              webmail settings
 *
 * The secret appears in exactly one response, the create, and is not
 * recoverable afterwards.
 */

const addressParam = z.object({ address_id: z.string().uuid() })
const itemParam = z.object({ address_id: z.string().uuid(), app_password_id: z.string().uuid() })
const createBody = {
  name: z.string().min(1).max(64),
  scopes: z.array(z.enum(APP_PASSWORD_SCOPES)).min(1).max(APP_PASSWORD_SCOPES.length).optional(),
}

/**
 * Whether to suggest `require_app_passwords`. The case it exists for: a mailbox
 * that signs in with an account password the panel guards with a second factor,
 * where IMAP and SMTP still take that password alone.
 */
const totpRecommended = async (address: Address): Promise<boolean> => {
  if (address.require_app_passwords || !address.user_id) return false
  const row = await db().one<{ totp_enabled: boolean }>({
    text: "SELECT totp_enabled FROM users WHERE id = $1",
    values: [address.user_id],
  })
  return Boolean(row?.totp_enabled)
}

const listing = async (address: Address) => ({
  object: "list" as const,
  data: (await listAppPasswords(address.id)).map(appPasswordObject),
  require_app_passwords: address.require_app_passwords,
  totp_recommended: await totpRecommended(address),
})

export const appPasswordRoutes: Route[] = [
  getR(
    "/api/addresses/:address_id/app-passwords",
    { params: addressParam, before: authed, assigns: {} as never },
    async (c) => {
      const { address } = await ownedAddress(principalOf(c).userId, c.params.address_id)
      return json(c, 200, await listing(address))
    },
  ),

  postR(
    "/api/addresses/:address_id/app-passwords",
    { params: addressParam, body: z.object(createBody), before: authed, assigns: {} as never },
    async (c) => {
      const { address } = await ownedAddress(principalOf(c).userId, c.params.address_id)
      const { appPassword, password } = await createAppPassword({
        address,
        name: c.body.name,
        scopes: c.body.scopes,
      })
      return json(c, 201, { ...appPasswordObject(appPassword), password })
    },
  ),

  delR(
    "/api/addresses/:address_id/app-passwords/:app_password_id",
    { params: itemParam, before: authed, assigns: {} as never },
    async (c) => {
      const { address } = await ownedAddress(principalOf(c).userId, c.params.address_id)
      if (!(await deleteAppPassword(address.id, c.params.app_password_id))) {
        throw notFound("App password not found.")
      }
      return json(c, 200, { object: "app_password", id: c.params.app_password_id, deleted: true })
    },
  ),

  getR("/api/mail/app-passwords", { before: mailed, assigns: {} as never }, async (c) => {
    const { address } = identityOf(c)
    const { totp_recommended: _, ...rest } = await listing(address)
    return json(c, 200, rest)
  }),

  /**
   * Requires the current password, as changing the recovery address does: an
   * app password outlives a change of the mailbox password by design, so an
   * unattended session that could mint one would be a credential that survives
   * the owner noticing and changing theirs.
   */
  postR(
    "/api/mail/app-passwords",
    {
      body: z.object({ ...createBody, current_password: z.string().max(200) }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)
      if (!(await verifyMailboxPassword(identity.address, c.body.current_password))) {
        await recordAuthFailure(ipOf(c as never), "webmail", identity.email).catch(() => {})
        throw unauthorized("That is not your current password.")
      }
      const { appPassword, password } = await createAppPassword({
        address: identity.address,
        name: c.body.name,
        scopes: c.body.scopes,
      })
      return json(c, 201, { ...appPasswordObject(appPassword), password })
    },
  ),

  delR(
    "/api/mail/app-passwords/:app_password_id",
    {
      params: z.object({ app_password_id: z.string().uuid() }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = identityOf(c)
      if (!(await deleteAppPassword(identity.address.id, c.params.app_password_id))) {
        throw notFound("App password not found.")
      }
      return json(c, 200, { object: "app_password", id: c.params.app_password_id, deleted: true })
    },
  ),
]
