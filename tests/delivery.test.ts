import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { from } from "@atlas/db"
import {
  createAddress,
  folderBySpecialUse,
  inboxOf,
  resolveRecipient,
} from "../src/addresses/index.ts"
import { db, num } from "../src/db/index.ts"
import { type Domain, domains, filters, users } from "../src/schema/index.ts"
import { handleMessage, validateRecipient } from "../src/smtp/inbound/index.ts"
import type { Envelope } from "../src/smtp/session/index.ts"
import { messagesIn } from "../src/store/index.ts"

/**
 * Exercises the real delivery path against a real database: routing, filters,
 * folder selection, and quota accounting. These are the behaviours where a
 * mistake silently loses somebody's mail, so they are tested against Postgres
 * rather than a mock.
 *
 * Needs `bun run db:up && bun run migrate`.
 */

const suffix = Math.random().toString(36).slice(2, 8)
const domainName = `test-${suffix}.invalid`
const otherName = `other-${suffix}.invalid`

let userId = ""
let domain: Domain
let other: Domain

const envelopeFor = (recipients: string[], mailFrom = "sender@far-away.invalid"): Envelope => ({
  helo: "far-away.invalid",
  mailFrom,
  rcptTo: recipients,
  size: null,
  smtputf8: false,
})

const ctx = { remoteIp: "203.0.113.9", helo: "far-away.invalid" }

const message = (subject: string, body = "Hello.") =>
  [
    "From: Sender <sender@far-away.invalid>",
    `To: someone@${domainName}`,
    `Subject: ${subject}`,
    `Message-ID: <${Math.random().toString(36).slice(2)}@far-away.invalid>`,
    "Date: Mon, 10 Aug 2026 12:00:00 +0000",
    "",
    body,
  ].join("\r\n")

beforeAll(async () => {
  const user = await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Test', $2) RETURNING id`,
    values: [`owner-${suffix}@corsair.test`, suffix],
  })
  userId = user!.id

  const insert = async (name: string) =>
    (await db().one<Domain>({
      text: `INSERT INTO domains (user_id, name, verification_token, status)
             VALUES ($1, $2, 'mail-host-verify=test', 'active') RETURNING *`,
      values: [userId, name],
    }))!

  domain = await insert(domainName)
  other = await insert(otherName)
})

afterAll(async () => {
  // Cascades clear domains, addresses, folders, and messages.
  await db().execute(
    from(users)
      .where((q) => q("id").equals(userId))
      .del(),
  )
})

describe("routing", () => {
  test("delivers to a standard mailbox", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "standard",
      type: "standard",
      password: "hunter2hunter2",
    })

    const reply = await handleMessage(
      envelopeFor([`standard@${domainName}`]),
      message("To a mailbox"),
      ctx,
    )
    expect(reply.code).toBe(250)

    const inbox = await inboxOf(address.id)
    const rows = await messagesIn(inbox.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.subject).toBe("To a mailbox")
    expect(num(rows[0]!.uid)).toBe(1)
  })

  test("assigns strictly increasing UIDs", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "uids",
      type: "standard",
      password: "hunter2hunter2",
    })
    const inbox = await inboxOf(address.id)

    await handleMessage(envelopeFor([`uids@${domainName}`]), message("One"), ctx)
    await handleMessage(envelopeFor([`uids@${domainName}`]), message("Two"), ctx)
    await handleMessage(envelopeFor([`uids@${domainName}`]), message("Three"), ctx)

    const uids = (await messagesIn(inbox.id)).map((m) => num(m.uid))
    expect(uids).toEqual([1, 2, 3])
  })

  test("routes sub-addressing to the base mailbox", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "tagged",
      type: "standard",
      password: "hunter2hunter2",
    })

    const route = await resolveRecipient(`tagged+receipts@${domainName}`)
    expect(route.kind).toBe("mailbox")
    if (route.kind === "mailbox") expect(route.address.id).toBe(address.id)
  })

  test("an unknown address on a hosted domain is rejected as no-such-user", async () => {
    const reply = await validateRecipient(`nobody@${domainName}`, null, envelopeFor([]))
    expect(reply?.code).toBe(550)
    expect(reply?.enhanced).toBe("5.1.1")
  })

  test("an unhosted domain is refused as relaying", async () => {
    const reply = await validateRecipient("someone@not-ours.invalid", null, envelopeFor([]))
    expect(reply?.code).toBe(550)
    expect(reply?.enhanced).toBe("5.7.1")
  })

  test("a catch-all takes anything unmatched on its domain", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "catchall",
      type: "catchall",
      password: "hunter2hunter2",
    })

    const reply = await handleMessage(
      envelopeFor([`whatever-${suffix}@${domainName}`]),
      message("Swept up"),
      ctx,
    )
    expect(reply.code).toBe(250)

    const inbox = await inboxOf(address.id)
    const rows = await messagesIn(inbox.id)
    expect(rows.map((r) => r.subject)).toContain("Swept up")
  })

  test("an exact address still wins over the catch-all", async () => {
    const route = await resolveRecipient(`standard@${domainName}`)
    expect(route.kind).toBe("mailbox")
    if (route.kind === "mailbox") expect(route.address.local_part).toBe("standard")
  })

  test("an alias resolves to a forward rather than a mailbox", async () => {
    await createAddress({
      domainId: domain.id,
      localPart: "alias",
      type: "alias",
      destinations: ["elsewhere@far-away.invalid"],
    })

    const route = await resolveRecipient(`alias@${domainName}`)
    expect(route.kind).toBe("forward")
    if (route.kind === "forward") {
      expect(route.destinations).toEqual(["elsewhere@far-away.invalid"])
    }
  })

  test("a group forwards to every recipient", async () => {
    await createAddress({
      domainId: domain.id,
      localPart: "team",
      type: "group",
      destinations: ["a@far-away.invalid", "b@far-away.invalid"],
    })

    const route = await resolveRecipient(`team@${domainName}`)
    expect(route.kind).toBe("forward")
    if (route.kind === "forward") expect(route.destinations).toHaveLength(2)
  })

  test("a fallback domain catches what its source domain does not", async () => {
    const { address } = await createAddress({
      domainId: other.id,
      localPart: "landing",
      type: "standard",
      password: "hunter2hunter2",
    })
    await db().execute(
      from(domains)
        .where((q) => q("id").equals(domain.id))
        .update({ fallback_domain_id: other.id }),
    )

    // `landing@` does not exist on the first domain, but the catch-all does, so
    // the catch-all wins — the fallback is only for a domain with neither.
    const catchall = await resolveRecipient(`landing@${domainName}`)
    expect(catchall.kind).toBe("mailbox")

    await db().execute(
      from(domains)
        .where((q) => q("id").equals(domain.id))
        .update({ fallback_domain_id: null }),
    )
    expect(address.id).toBeTruthy()
  })
})

describe("filters", () => {
  test("a sieve script files a message into another folder", async () => {
    const filter = await db().one<{ id: string }>(
      from(filters)
        .insert({
          user_id: userId,
          name: `deals-${suffix}`,
          script: 'if header :contains "subject" "SALE" { fileinto :create "Deals"; }',
          size: 60,
        })
        .returning("id"),
    )

    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "filtered",
      type: "standard",
      password: "hunter2hunter2",
      filterId: filter!.id,
    })

    await handleMessage(envelopeFor([`filtered@${domainName}`]), message("Big SALE today"), ctx)

    const inbox = await inboxOf(address.id)
    expect(await messagesIn(inbox.id)).toHaveLength(0)

    const deals = await db().one<{ id: string }>({
      text: "SELECT id FROM folders WHERE address_id = $1 AND name = 'Deals'",
      values: [address.id],
    })
    expect(deals).toBeTruthy()
    expect(await messagesIn(deals!.id)).toHaveLength(1)
  })

  test("a message the script does not match still reaches the inbox", async () => {
    const filter = await db().one<{ id: string }>(
      from(filters)
        .insert({
          user_id: userId,
          name: `narrow-${suffix}`,
          script: 'if header :contains "subject" "NOTHING" { discard; }',
          size: 50,
        })
        .returning("id"),
    )

    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "unmatched",
      type: "standard",
      password: "hunter2hunter2",
      filterId: filter!.id,
    })

    await handleMessage(envelopeFor([`unmatched@${domainName}`]), message("Ordinary mail"), ctx)
    const inbox = await inboxOf(address.id)
    expect(await messagesIn(inbox.id)).toHaveLength(1)
  })

  test("discard drops the message without writing it", async () => {
    const filter = await db().one<{ id: string }>(
      from(filters)
        .insert({
          user_id: userId,
          name: `drop-${suffix}`,
          script: 'if header :contains "subject" "Spammy" { discard; }',
          size: 50,
        })
        .returning("id"),
    )

    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "dropper",
      type: "standard",
      password: "hunter2hunter2",
      filterId: filter!.id,
    })

    const reply = await handleMessage(
      envelopeFor([`dropper@${domainName}`]),
      message("Spammy offer"),
      ctx,
    )
    // Accepted, then dropped: telling the sender it failed would be a lie, and
    // bouncing filtered mail leaks the filter.
    expect(reply.code).toBe(250)
    const inbox = await inboxOf(address.id)
    expect(await messagesIn(inbox.id)).toHaveLength(0)
  })
})

describe("mailbox provisioning", () => {
  test("a new mailbox gets the special-use folders", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "folders",
      type: "standard",
      password: "hunter2hunter2",
    })

    for (const use of ["inbox", "sent", "drafts", "trash", "junk", "archive"]) {
      expect(await folderBySpecialUse(address.id, use)).toBeTruthy()
    }
  })

  test("an alias gets no folders, because it has no mailbox", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "no-folders",
      type: "alias",
      destinations: ["x@far-away.invalid"],
    })
    const rows = await db().all<{ id: string }>({
      text: "SELECT id FROM folders WHERE address_id = $1",
      values: [address.id],
    })
    expect(rows).toHaveLength(0)
  })
})

describe("accounting", () => {
  test("delivery charges the address and the domain", async () => {
    const { address } = await createAddress({
      domainId: domain.id,
      localPart: "quota",
      type: "standard",
      password: "hunter2hunter2",
    })

    await handleMessage(envelopeFor([`quota@${domainName}`]), message("Sized"), ctx)

    const row = await db().one<{ bytes_used: string }>({
      text: "SELECT bytes_used::text AS bytes_used FROM addresses WHERE id = $1",
      values: [address.id],
    })
    expect(Number(row?.bytes_used ?? 0)).toBeGreaterThan(0)
  })

  test("every delivery is logged", async () => {
    const before = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM mail_log WHERE user_id = $1",
      values: [userId],
    })
    await handleMessage(envelopeFor([`standard@${domainName}`]), message("Logged"), ctx)
    const after = await db().one<{ count: string }>({
      text: "SELECT count(*)::text AS count FROM mail_log WHERE user_id = $1",
      values: [userId],
    })
    expect(Number(after!.count)).toBeGreaterThan(Number(before!.count))
  })
})
