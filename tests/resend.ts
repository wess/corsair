/**
 * The official `resend` package against a running Corsair, with nothing changed
 * but the base URL. This is the compatibility claim in the docs, verified.
 *
 *   bun run dev             # in one terminal
 *   bun run test:resend     # in another
 *
 * Not part of `bun test`: it needs a live server. The account, domain, and key
 * are written straight into the database, because the domain has to be verified
 * to send and nothing on a laptop can publish its DNS. All three are removed at
 * the end, with whatever the run queued.
 */
import { Resend } from "resend"
import { createApiKey } from "../src/apikeys/index.ts"
import { closeDb, db } from "../src/db/index.ts"

const BASE = process.env.CORSAIR_URL ?? "http://localhost:3000"
const suffix = Math.random().toString(36).slice(2, 8)
const zone = `sdk-${suffix}.invalid`

let passed = 0
let failed = 0

const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    passed++
    console.log(`  ok    ${label}`)
    return
  }
  failed++
  console.error(`  FAIL  ${label}`)
  if (detail !== undefined) console.error(`        ${JSON.stringify(detail).slice(0, 300)}`)
}

// The SDK does not back off, and the limiter is real.
const pace = () => new Promise((resolve) => setTimeout(resolve, 150))

const userId = (await db().one<{ id: string }>({
  text: `INSERT INTO users (email, password_hash, name, referral_code)
         VALUES ($1, 'x', 'SDK', $2) RETURNING id`,
  values: [`sdk-${suffix}@corsair.test`, suffix],
}))!.id

try {
  await db().execute({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'mail-host-verify=sdk', 'active')`,
    values: [userId, zone],
  })
  const { token } = await createApiKey({ userId, name: "sdk", permission: "full_access" })

  const resend = new Resend(token, { baseUrl: `${BASE}/api` })
  const from = `Acme <hello@${zone}>`

  const sent = await resend.emails.send({
    from,
    to: ["someone@far.invalid"],
    subject: "Sent by the official Resend SDK",
    html: "<strong>It works.</strong>",
    tags: [{ name: "source", value: "sdk_test" }],
    attachments: [{ filename: "hello.txt", content: Buffer.from("hello") }],
  })
  check("emails.send", !sent.error && Boolean(sent.data?.id), sent.error ?? sent.data)

  await pace()
  const fetched = await resend.emails.get(sent.data!.id)
  check(
    "emails.get returns the same email",
    fetched.data?.id === sent.data!.id &&
      fetched.data?.subject === "Sent by the official Resend SDK",
    fetched.error ?? fetched.data,
  )

  await pace()
  const listed = await resend.emails.list({ limit: 10 })
  check(
    "emails.list",
    !listed.error && (listed.data?.data ?? []).some((e) => e.id === sent.data!.id),
    listed.error ?? listed.data,
  )

  await pace()
  const batch = await resend.batch.send([
    { from, to: ["one@far.invalid"], subject: "One", text: "1" },
    { from, to: ["two@far.invalid"], subject: "Two", text: "2" },
  ])
  check("batch.send", batch.data?.data.length === 2, batch.error ?? batch.data)

  await pace()
  const scheduled = await resend.emails.send({
    from,
    to: ["later@far.invalid"],
    subject: "Later",
    text: "later",
    scheduledAt: "in 1 hour",
  })
  check("a send can be scheduled", Boolean(scheduled.data?.id), scheduled.error)

  await pace()
  const updated = await resend.emails.update({
    id: scheduled.data!.id,
    scheduledAt: new Date(Date.now() + 2 * 3_600_000).toISOString(),
  })
  check("emails.update reschedules", updated.data?.id === scheduled.data!.id, updated.error)

  await pace()
  const canceled = await resend.emails.cancel(scheduled.data!.id)
  const afterCancel = await resend.emails.get(scheduled.data!.id)
  check(
    "emails.cancel",
    !canceled.error && afterCancel.data?.last_event === "canceled",
    canceled.error ?? afterCancel.data,
  )

  await pace()
  const idempotencyKey = `sdk-${suffix}`
  const payload = { from, to: ["once@far.invalid"], subject: "Once", text: "once" }
  const first = await resend.emails.send(payload, { idempotencyKey })
  await pace()
  const again = await resend.emails.send(payload, { idempotencyKey })
  check(
    "an idempotency key replays rather than resending",
    Boolean(first.data?.id) && first.data?.id === again.data?.id,
    { first: first.data, again: again.data },
  )

  await pace()
  const foreign = await resend.emails.send({
    from: "someone@not-hosted.invalid",
    to: ["x@far.invalid"],
    subject: "No",
    text: "no",
  })
  check(
    "an unverified sender comes back as a Resend error",
    foreign.error?.name === "validation_error" &&
      (foreign.error as { statusCode?: number }).statusCode === 403,
    foreign.error,
  )
} finally {
  await db().execute({
    text: "DELETE FROM deliveries WHERE email_id IN (SELECT id FROM emails WHERE user_id = $1)",
    values: [userId],
  })
  await db().execute({ text: "DELETE FROM mail_log WHERE user_id = $1", values: [userId] })
  await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [userId] })
  await closeDb()
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
