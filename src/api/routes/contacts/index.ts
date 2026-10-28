import { delR, getR, json, patchR, postR, type Route } from "@wess/atlas/server"
import { z } from "zod"
import type { MailIdentity } from "../../../auth/index.ts"
import {
  bookOf,
  contactsAllowed,
  createContact,
  deleteContact,
  editVcard,
  ownedContact,
  putContact,
  searchContacts,
} from "../../../contacts/index.ts"
import { conflict, forbidden, notFound } from "../../../errors/index.ts"
import { contactObject } from "../../../serialize/index.ts"
import { identityOf, mailed } from "../../pipes/index.ts"

/**
 * The webmail's view of the mailbox's address book: the same rows CardDAV
 * serves, so a contact added on a phone autocompletes in compose and one added
 * here syncs to the phone.
 *
 * Every query is scoped by `address_id` in SQL. A contact id from another
 * mailbox is a 404, the same as one that does not exist.
 *
 * Sent-to recipients are not added automatically. Who someone has written to is
 * a different record with a different purpose, and silently filling a synced
 * address book with it would push every one-off reply onto their phone.
 */

const allowed = (identity: MailIdentity): MailIdentity => {
  if (!contactsAllowed(identity.address)) throw forbidden("This mailbox has no address book.")
  return identity
}

const body = z.object({
  name: z.string().trim().min(1).max(200),
  emails: z.array(z.string().email().max(320)).max(20),
})

export const contactRoutes: Route[] = [
  getR(
    "/api/mail/contacts",
    {
      query: z.record(z.string(), z.string()).optional(),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = allowed(identityOf(c))
      const query = (c.query ?? {}) as Record<string, string>
      const limit = Math.min(500, Math.max(1, Number(query.limit ?? "20") || 20))
      const rows = await searchContacts(identity.address.id, (query.q ?? "").slice(0, 200), limit)
      return json(c, 200, { object: "list", data: rows.map(contactObject) })
    },
  ),

  postR("/api/mail/contacts", { body, before: mailed, assigns: {} as never }, async (c) => {
    const identity = allowed(identityOf(c))
    const contact = await createContact(identity.address.id, c.body)
    return json(c, 201, contactObject(contact))
  }),

  patchR(
    "/api/mail/contacts/:contact_id",
    {
      params: z.object({ contact_id: z.string().uuid() }),
      body,
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = allowed(identityOf(c))
      const contact = await ownedContact(identity.address.id, c.params.contact_id)
      const book = contact && (await bookOf(contact))
      if (!contact || !book) throw notFound("Contact not found.")

      // Conditional on the etag read above: if a phone rewrote the card in the
      // meantime, this refuses rather than silently dropping the phone's edit.
      const result = await putContact({
        book,
        href: contact.href,
        vcard: editVcard(contact.vcard, c.body),
        precondition: { ifMatch: `"${contact.etag}"` },
      })
      if (!result.ok) throw conflict("This contact changed elsewhere. Reload and try again.")
      return json(c, 200, contactObject(result.contact))
    },
  ),

  delR(
    "/api/mail/contacts/:contact_id",
    {
      params: z.object({ contact_id: z.string().uuid() }),
      before: mailed,
      assigns: {} as never,
    },
    async (c) => {
      const identity = allowed(identityOf(c))
      const contact = await ownedContact(identity.address.id, c.params.contact_id)
      const book = contact && (await bookOf(contact))
      if (!contact || !book) throw notFound("Contact not found.")
      await deleteContact({ book, href: contact.href })
      return json(c, 200, { object: "contact", id: contact.id, deleted: true })
    },
  ),
]
