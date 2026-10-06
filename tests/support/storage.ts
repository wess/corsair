import { afterAll, beforeAll, expect, test } from "bun:test"

const objects = new Map<string, Buffer>()
let failUpload = false
let failRead = false
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const key = new URL(request.url).pathname
    if (request.method === "PUT") {
      if (failUpload) return new Response("unavailable", { status: 503 })
      objects.set(key, Buffer.from(await request.arrayBuffer()))
      return new Response(null)
    }
    if (request.method === "DELETE") {
      objects.delete(key)
      return new Response(null, { status: 204 })
    }
    if (failRead) return new Response("unavailable", { status: 503 })
    const body = objects.get(key)
    return body ? new Response(new Uint8Array(body)) : new Response(null, { status: 404 })
  },
})

process.env.STORAGE_ENDPOINT = server.url.origin
process.env.STORAGE_BUCKET = "test"
process.env.STORAGE_ACCESS_KEY_ID = "test"
process.env.STORAGE_SECRET_ACCESS_KEY = "test"

const { createAddress, inboxOf } = await import("../../src/addresses/index.ts")
const { db, closeDb, num } = await import("../../src/db/index.ts")
const { copyTo, deliver, expunge, folderOf, messagesIn, moveTo } = await import(
  "../../src/store/index.ts"
)
const { getRaw, putInline, putRaw, deleteRaw } = await import("../../src/storage/index.ts")

let userId = ""
let addressId = ""
let inboxId = ""
let archiveId = ""
const raw = "From: sender@example.test\r\nSubject: octets\r\n\r\ncaf\xe9\r\n"

beforeAll(async () => {
  const suffix = crypto.randomUUID()
  userId = (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code)
           VALUES ($1, 'x', 'Storage', $2) RETURNING id`,
    values: [`storage-${suffix}@example.test`, suffix],
  }))!.id
  const domain = await db().one<{ id: string }>({
    text: `INSERT INTO domains (user_id, name, verification_token, status)
           VALUES ($1, $2, 'test', 'active') RETURNING id`,
    values: [userId, `storage-${suffix}.invalid`],
  })
  const { address } = await createAddress({
    domainId: domain!.id,
    localPart: "mail",
    type: "standard",
    password: "test-storage-password",
  })
  addressId = address.id
  inboxId = (await inboxOf(addressId)).id
  archiveId = (await folderOf(addressId, "Archive"))!.id
})

afterAll(async () => {
  await db().execute({ text: "DELETE FROM users WHERE id = $1", values: [userId] })
  await closeDb()
  server.stop(true)
})

test("S3 round-trips every octet without UTF-8 expansion", async () => {
  const body = Buffer.from(Array.from({ length: 256 }, (_, i) => i)).toString("latin1")
  await putRaw("octets.eml", body)
  expect(objects.get("/test/octets.eml")).toEqual(Buffer.from(body, "latin1"))
  expect(await getRaw({ storageKey: "octets.eml" })).toBe(body)
  await deleteRaw("octets.eml")
})

test("expunging an original preserves a copy until its own expunge", async () => {
  const original = await deliver({ addressId, folderId: inboxId, raw })
  const result = await copyTo({ messageIds: [original.id], targetFolderId: archiveId })
  const copy = (await messagesIn(archiveId)).find((row) => num(row.uid) === result.targetUids[0])!
  expect(copy.storage_key).toBe(original.storage_key)
  await expunge({ folderId: inboxId, messageIds: [original.id] })
  expect(await getRaw({ storageKey: copy.storage_key })).toBe(raw)
  await expunge({ folderId: archiveId, messageIds: [copy.id] })
  expect(objects.has(`/test/${copy.storage_key}`)).toBe(false)
})

test("failed uploads leave no visible message, UID allocation, or quota charge", async () => {
  const before = await messagesIn(inboxId)
  const folderBefore = await folderOf(addressId, "INBOX")
  failUpload = true
  try {
    await expect(deliver({ addressId, folderId: inboxId, raw })).rejects.toThrow("503")
  } finally {
    failUpload = false
  }
  expect(await messagesIn(inboxId)).toEqual(before)
  expect((await folderOf(addressId, "INBOX"))!.uid_next).toBe(folderBefore!.uid_next)
  const usage = await db().one<{ bytes_used: bigint }>({
    text: "SELECT bytes_used FROM addresses WHERE id = $1",
    values: [addressId],
  })
  expect(num(usage!.bytes_used)).toBe(0)
})

test("a database failure rolls back the UID and removes the uploaded object", async () => {
  const before = objects.size
  const folderBefore = await folderOf(addressId, "INBOX")
  await expect(
    deliver({ addressId: crypto.randomUUID(), folderId: inboxId, raw }),
  ).rejects.toThrow()
  expect(objects.size).toBe(before)
  expect((await folderOf(addressId, "INBOX"))!.uid_next).toBe(folderBefore!.uid_next)
})

test("failed accounting rolls back the message and body as well as its UID", async () => {
  const before = objects.size
  const folderBefore = await folderOf(addressId, "INBOX")
  await db().execute({
    text: "UPDATE addresses SET bytes_used = 9223372036854775807 WHERE id = $1",
    values: [addressId],
  })
  try {
    await expect(deliver({ addressId, folderId: inboxId, raw })).rejects.toThrow()
    expect(await messagesIn(inboxId)).toHaveLength(0)
    expect(objects.size).toBe(before)
    expect((await folderOf(addressId, "INBOX"))!.uid_next).toBe(folderBefore!.uid_next)
  } finally {
    await db().execute({
      text: "UPDATE addresses SET bytes_used = 0 WHERE id = $1",
      values: [addressId],
    })
  }
})

test("COPY still duplicates old inline bodies after a bucket is configured", async () => {
  const original = await deliver({ addressId, folderId: inboxId, raw })
  await putInline(original.id, raw)
  await db().execute({
    text: "UPDATE messages SET storage_key = NULL WHERE id = $1",
    values: [original.id],
  })
  await deleteRaw(original.storage_key)
  const result = await copyTo({ messageIds: [original.id], targetFolderId: archiveId })
  const copy = (await messagesIn(archiveId)).find((row) => num(row.uid) === result.targetUids[0])!
  expect(await getRaw({ storageKey: copy.storage_key, messageId: copy.id })).toBe(raw)
})

test("a copy racing with expunge never keeps a deleted body", async () => {
  for (let i = 0; i < 12; i++) {
    const original = await deliver({ addressId, folderId: inboxId, raw })
    const [copy] = await Promise.all([
      copyTo({ messageIds: [original.id], targetFolderId: archiveId }),
      expunge({ folderId: inboxId, messageIds: [original.id] }),
    ])
    if (copy.targetUids.length) {
      const row = (await messagesIn(archiveId)).find((m) => num(m.uid) === copy.targetUids[0])!
      expect(await getRaw({ storageKey: row.storage_key })).toBe(raw)
      await expunge({ folderId: archiveId, messageIds: [row.id] })
    }
  }
})

test("opposite-direction moves complete and preserve both message ids", async () => {
  const a = await deliver({ addressId, folderId: inboxId, raw })
  const b = await deliver({ addressId, folderId: archiveId, raw })
  await Promise.all([
    moveTo({ messageIds: [a.id], targetFolderId: archiveId }),
    moveTo({ messageIds: [b.id], targetFolderId: inboxId }),
  ])
  expect((await messagesIn(archiveId)).some((row) => row.id === a.id)).toBe(true)
  expect((await messagesIn(inboxId)).some((row) => row.id === b.id)).toBe(true)
})

test("COPYUID pairs stay aligned when input ids are out of UID order", async () => {
  const originals = []
  for (const subject of ["first", "second", "third"]) {
    originals.push(
      await deliver({ addressId, folderId: inboxId, raw: `Subject: ${subject}\r\n\r\n` }),
    )
  }
  const copy = await copyTo({
    messageIds: originals.toReversed().map((row) => row.id),
    targetFolderId: archiveId,
  })
  const rows = await messagesIn(archiveId)
  expect(copy.sourceUids).toEqual(originals.map((row) => num(row.uid)))
  for (const [i, uid] of copy.targetUids.entries()) {
    expect(rows.find((row) => num(row.uid) === uid)!.subject).toBe(originals[i]!.subject)
  }
})

test("storage read outages defer queued mail without spending a delivery attempt", async () => {
  const { enqueue } = await import("../../src/outbound/index.ts")
  const { drain } = await import("../../src/smtp/queue/index.ts")
  const [delivery] = await enqueue({
    mailFrom: "sender@example.test",
    recipients: ["recipient@example.test"],
    raw,
  })
  await db().execute({
    text: "UPDATE deliveries SET run_at = now() - interval '100 years' WHERE id = $1",
    values: [delivery!.id],
  })
  failRead = true
  try {
    await expect(getRaw({ storageKey: delivery!.storage_key })).rejects.toThrow(
      "temporarily unavailable",
    )
    const result = await drain(1)
    expect(result.deferred).toBe(1)
    expect(result.failed).toBe(0)
    const row = await db().one<{ status: string; attempts: number; last_code: number }>({
      text: "SELECT status, attempts, last_code FROM deliveries WHERE id = $1",
      values: [delivery!.id],
    })
    expect(row).toEqual({ status: "deferred", attempts: 0, last_code: 451 })
    expect(objects.has(`/test/${delivery!.storage_key}`)).toBe(true)
  } finally {
    failRead = false
    await db().execute({ text: "DELETE FROM deliveries WHERE id = $1", values: [delivery!.id] })
  }
})

test("only a confirmed missing object is treated as missing mail", async () => {
  expect(await getRaw({ storageKey: "missing.eml" })).toBeNull()
})
