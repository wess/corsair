import { getR, json, patchR, postR, type Route } from "@atlas/server"
import { z } from "zod"
import { invalidParameter } from "../../../errors/index.ts"
import { withIdempotency } from "../../../idempotency/index.ts"
import {
  cancelEmail,
  createEmail,
  findEmail,
  listEmails,
  type Prepared,
  prepareSend,
  rescheduleEmail,
  type SendInput,
} from "../../../sending/index.ts"
import { emailObject } from "../../../serialize/index.ts"
import { senderOf, sending, sendingFull } from "../../pipes/index.ts"

/**
 * The sending API, on Resend's paths under `/api`.
 *
 * Point a Resend SDK at `https://<server>/api` and these are the routes it
 * calls. Fields are optional in the schema on purpose: a missing `to` must come
 * back as Resend's `missing_required_field`, not as a generic validation error
 * a Resend client does not know to expect.
 */

const byte = z.number().int().min(0).max(255)
const addressish = z.union([z.string(), z.array(z.string())]).nullish()

const sendSchema = z.object({
  from: z.string().optional(),
  to: addressish,
  cc: addressish,
  bcc: addressish,
  reply_to: addressish,
  subject: z.string().optional(),
  html: z.string().nullish(),
  text: z.string().nullish(),
  headers: z.record(z.string()).optional(),
  tags: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .max(50)
    .optional(),
  scheduled_at: z.string().nullish(),
  attachments: z
    .array(
      z.object({
        content: z
          .union([
            z.string(),
            z.array(byte),
            z.object({ type: z.literal("Buffer"), data: z.array(byte) }),
          ])
          .nullish(),
        filename: z.string().nullish(),
        path: z.string().nullish(),
        content_type: z.string().nullish(),
        content_id: z.string().nullish(),
      }),
    )
    .max(100)
    .optional(),
  template: z.unknown().optional(),
  topic_id: z.unknown().optional(),
})

const idParam = z.object({ id: z.string().uuid() })

export const emailRoutes: Route[] = [
  // Ahead of anything shaped `/api/emails/:id`.
  postR(
    "/api/emails/batch",
    { body: z.array(sendSchema).min(1).max(100), before: sending, assigns: {} as never },
    async (c) => {
      const sender = senderOf(c)
      const result = await withIdempotency(
        sender.userId,
        c.headers.get("idempotency-key"),
        c.body,
        async () => {
          // Every entry is validated before any is queued, so a batch with one
          // bad email sends nothing rather than most of it.
          const prepared: Prepared[] = []
          for (const [index, item] of c.body.entries()) {
            if (item.attachments?.length || item.scheduled_at) {
              throw invalidParameter(
                `Email ${index}: attachments and \`scheduled_at\` are not supported in a batch.`,
              )
            }
            prepared.push(await prepareSend(item as SendInput, sender))
          }
          const data: { id: string }[] = []
          for (const entry of prepared) data.push({ id: (await createEmail(entry, sender)).id })
          return { data }
        },
      )
      return json(c, result.status, result.body)
    },
  ),

  postR("/api/emails", { body: sendSchema, before: sending, assigns: {} as never }, async (c) => {
    const sender = senderOf(c)
    const result = await withIdempotency(
      sender.userId,
      c.headers.get("idempotency-key"),
      c.body,
      async () => {
        const prepared = await prepareSend(c.body as SendInput, sender)
        return { id: (await createEmail(prepared, sender)).id }
      },
    )
    return json(c, result.status, result.body)
  }),

  getR(
    "/api/emails",
    { query: z.record(z.string()).optional(), before: sendingFull, assigns: {} as never },
    async (c) => {
      const page = await listEmails(
        senderOf(c).userId,
        (c.query ?? {}) as { limit?: string; after?: string; before?: string },
      )
      return json(c, 200, {
        object: "list",
        has_more: page.hasMore,
        data: page.data.map((email) => emailObject(email)),
      })
    },
  ),

  getR(
    "/api/emails/:id",
    { params: idParam, before: sendingFull, assigns: {} as never },
    async (c) =>
      json(c, 200, emailObject(await findEmail(senderOf(c).userId, c.params.id), { full: true })),
  ),

  patchR(
    "/api/emails/:id",
    {
      params: idParam,
      body: z.object({ scheduled_at: z.string() }),
      before: sendingFull,
      assigns: {} as never,
    },
    async (c) => {
      const email = await findEmail(senderOf(c).userId, c.params.id)
      await rescheduleEmail(email, c.body.scheduled_at)
      return json(c, 200, { object: "email", id: email.id })
    },
  ),

  postR(
    "/api/emails/:id/cancel",
    { params: idParam, before: sendingFull, assigns: {} as never },
    async (c) => {
      const email = await findEmail(senderOf(c).userId, c.params.id)
      await cancelEmail(email)
      return json(c, 200, { object: "email", id: email.id })
    },
  ),
]
