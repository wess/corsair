import { from } from "@atlas/db"
import { folderBySpecialUse } from "../../addresses/index.ts"
import { db } from "../../db/index.ts"
import { config } from "../../config/index.ts"
import { resolvePublicHost } from "../../safefetch/index.ts"
import { peerError } from "../../tlsverify/index.ts"
import { createWriter } from "../../socketio/index.ts"
import { uidValidity } from "../../ids/index.ts"
import {
  type Address,
  addresses,
  type Folder,
  folders,
  type Transfer,
  transfers,
} from "../../schema/index.ts"
import { decryptSecret } from "../../secrets/index.ts"
import { deliver } from "../../store/index.ts"

/**
 * Migrates a mailbox from another host over IMAP.
 *
 * A minimal IMAP *client* rather than a library: the operations needed are
 * LIST, SELECT, and a UID FETCH loop, and the awkward parts (literal framing,
 * multi-line responses) are the same ones the server side already models.
 */

const CRLF = "\r\n"

export const decryptPassword = decryptSecret

type Client = {
  send: (command: string) => Promise<string>
  close: () => void
}

export const connectSource = async (input: {
  host: string
  port: number
  secure: boolean
  timeoutMs: number
}): Promise<Client> => {
  let buffer = ""
  let closed = false
  let notify: (() => void) | null = null
  if (!input.secure) throw new Error("Mailbox transfers require TLS.")
  const address = await resolvePublicHost(input.host, config.transferAllowPrivate)
  let failure: Error | null = null
  let writer: ReturnType<typeof createWriter>

  const socket = await Bun.connect({
    hostname: address,
    port: input.port,
    tls: { rejectUnauthorized: true, serverName: input.host },
    socket: {
      handshake(socket: Bun.Socket<unknown>, success: boolean, error: Error | null) {
        const invalid = peerError(socket, input.host, error)
        if (!success || invalid) {
          failure = invalid ?? new Error("The source TLS handshake failed.")
          closed = true
          socket.end()
          notify?.()
        }
      },
      data(_s: { end: () => void }, data: Uint8Array) {
        if (closed) return
        if (buffer.length + data.byteLength > config.maxMessageBytes + 64 * 1024) {
          failure = new Error("The source response exceeds the message size limit.")
          closed = true
          _s.end()
          notify?.()
          return
        }
        buffer += Buffer.from(data).toString("latin1")
        notify?.()
      },
      drain() {
        writer?.drain()
      },
      timeout(s: { end: () => void }) {
        failure = new Error("The source connection timed out.")
        s.end()
        closed = true
        notify?.()
      },
      close() {
        writer?.close()
        closed = true
        notify?.()
      },
      error(_s: unknown, error: Error) {
        failure = error
        closed = true
        notify?.()
      },
    } as never,
  })
  writer = createWriter(() => socket)
  socket.timeout(Math.ceil(input.timeoutMs / 1000))

  let counter = 0

  /**
   * Reads until the tagged completion line for this command.
   *
   * Waiting for "a line" is not enough: a FETCH answer is many lines and can
   * carry literals whose bytes may look like a tagged response. Matching on the
   * tag at the start of a line is what keeps the reader in step.
   */
  const readUntil = async (tag: string): Promise<string> => {
    const deadline = Date.now() + input.timeoutMs
    const pattern = new RegExp(`^${tag} (OK|NO|BAD)(?: |$)`)
    let position = 0
    while (true) {
      while (true) {
        const end = buffer.indexOf(CRLF, position)
        if (end === -1) break
        const line = buffer.slice(position, end)
        if (pattern.test(line)) {
          const out = buffer.slice(0, end + 2)
          buffer = buffer.slice(end + 2)
          return out
        }
        const literal = line.match(/\{(\d+)\}$/)
        const size = literal ? Number(literal[1]) : 0
        if (!Number.isSafeInteger(size) || size > config.maxMessageBytes)
          throw new Error("The source literal exceeds the message size limit.")
        const next = end + 2 + size
        if (buffer.length < next) break
        position = next
      }
      if (closed) throw failure ?? new Error("the remote server closed the connection")
      if (Date.now() > deadline) throw new Error("timed out waiting for the remote server")
      await new Promise<void>((resolve) => {
        notify = resolve
        setTimeout(resolve, 200)
      })
      notify = null
    }
  }

  try {
    const deadline = Date.now() + input.timeoutMs
    while (!buffer.includes(CRLF)) {
      if (closed) throw failure ?? new Error("The source closed before its greeting.")
      if (Date.now() > deadline) throw new Error("The source greeting timed out.")
      await Bun.sleep(50)
    }
    if (closed) throw failure ?? new Error("The source closed the connection.")
    if (!/^\* OK(?: |\r\n)/i.test(buffer))
      throw new Error("The source refused the IMAP connection.")
    buffer = ""
  } catch (error) {
    socket.end()
    throw error
  }

  return {
    send: async (command) => {
      const tag = `c${++counter}`
      writer.write(`${tag} ${command}${CRLF}`)
      return readUntil(tag)
    },
    close: () => {
      try {
        socket.end()
      } catch {
        // already gone
      }
    },
  }
}

const quote = (value: string) => {
  if (/[\r\n\0]/.test(value)) throw new Error("An IMAP argument contains control characters.")
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

const parseFolderList = (response: string): string[] => {
  const out: string[] = []
  for (const line of response.split(CRLF)) {
    if (!line.startsWith("* LIST")) continue
    // Skip containers that hold no messages.
    if (/\\Noselect/i.test(line)) continue
    const quoted = line.match(/"([^"]*)"\s*$/)
    if (quoted?.[1]) {
      out.push(quoted[1])
      continue
    }
    const bare = line.trim().split(/\s+/).pop()
    if (bare && bare !== "NIL") out.push(bare)
  }
  return out
}

/** Splits a FETCH response into the individual message bodies it carries. */
const parseFetchedMessages = (response: string): string[] => {
  const out: string[] = []
  let i = 0
  while (true) {
    const marker = response.indexOf("{", i)
    if (marker === -1) break
    const close = response.indexOf("}", marker)
    if (close === -1) break
    const size = Number(response.slice(marker + 1, close))
    if (!Number.isFinite(size)) {
      i = close + 1
      continue
    }
    let start = close + 1
    if (response.startsWith(CRLF, start)) start += 2
    out.push(response.slice(start, start + size))
    i = start + size
  }
  return out
}

const localFolderFor = async (addressId: string, remoteName: string): Promise<Folder> => {
  // Map the common remote names onto the local special-use folders rather than
  // creating "[Gmail]/Sent Mail" alongside "Sent".
  const normalized = remoteName.replace(/^\[Gmail\]\//i, "").trim()
  const lower = normalized.toLowerCase()
  const specialUse =
    lower === "inbox"
      ? "inbox"
      : /^sent( mail| items| messages)?$/.test(lower)
        ? "sent"
        : /^(drafts?)$/.test(lower)
          ? "drafts"
          : /^(trash|deleted items|bin)$/.test(lower)
            ? "trash"
            : /^(junk|spam|junk e-?mail)$/.test(lower)
              ? "junk"
              : /^(archive|all mail)$/.test(lower)
                ? "archive"
                : null

  if (specialUse) {
    const existing = await folderBySpecialUse(addressId, specialUse)
    if (existing) return existing
  }

  const name = normalized || remoteName
  const found = await db().one<Folder>(
    from(folders).where((q) => [q("address_id").equals(addressId), q("name").equals(name)]),
  )
  if (found) return found

  return (await db().one<Folder>(
    from(folders)
      .insert({ address_id: addressId, name, uid_validity: uidValidity() })
      .returning(
        "id",
        "address_id",
        "name",
        "special_use",
        "uid_validity",
        "uid_next",
        "highest_modseq",
        "subscribed",
        "created_at",
        "updated_at",
      ),
  ))!
}

const BATCH = 1

export const runTransfer = async (transfer: Transfer): Promise<void> => {
  const address = await db().one<Address>(
    from(addresses).where((q) => q("id").equals(transfer.address_id)),
  )
  if (!address) throw new Error("the destination address no longer exists")

  const password = transfer.password_enc ? decryptPassword(transfer.password_enc) : ""
  if (!password) throw new Error("the stored source password could not be read")

  const update = (patch: Record<string, unknown>) =>
    db().execute(
      from(transfers)
        .where((q) => [q("id").equals(transfer.id), q("status").notEquals("cancelled")])
        .update({ ...patch, updated_at: new Date() }),
    )

  const begun = await db().one<{ id: string }>({
    text: "UPDATE transfers SET status = 'running', started_at = now(), last_error = NULL, updated_at = now() WHERE id = $1 AND status = 'queued' RETURNING id",
    values: [transfer.id],
  })
  if (!begun) return

  const client = await connectSource({
    host: transfer.server,
    port: transfer.port,
    secure: transfer.secure,
    timeoutMs: 120_000,
  })

  try {
    const login = await client.send(`LOGIN ${quote(transfer.username)} ${quote(password)}`)
    if (!/ OK/i.test(login)) throw new Error("the source server rejected those credentials")

    const remoteFolders = parseFolderList(await client.send('LIST "" "*"'))
    await update({ folders_total: remoteFolders.length })

    let copied = 0
    let bytes = 0
    let foldersDone = 0

    const cancelled = async () => {
      const row = await db().one<{ status: string }>({
        text: "SELECT status FROM transfers WHERE id = $1",
        values: [transfer.id],
      })
      return !row || row.status === "cancelled"
    }
    copy: for (const remote of remoteFolders) {
      if (await cancelled()) return
      const selected = await client.send(`EXAMINE ${quote(remote)}`)
      const exists = Number(selected.match(/\* (\d+) EXISTS/)?.[1] ?? "0")
      if (!exists) {
        foldersDone++
        await update({ folders_done: foldersDone })
        continue
      }

      const target = await localFolderFor(address.id, remote)

      // Search rather than blindly fetching 1:*, so `newer_than` is applied by
      // the source server instead of pulling everything and discarding it.
      let uids: number[] = []
      if (transfer.newer_than) {
        const since = transfer.newer_than
        const months = [
          "Jan",
          "Feb",
          "Mar",
          "Apr",
          "May",
          "Jun",
          "Jul",
          "Aug",
          "Sep",
          "Oct",
          "Nov",
          "Dec",
        ]
        const stamp = `${since.getUTCDate()}-${months[since.getUTCMonth()]}-${since.getUTCFullYear()}`
        const found = await client.send(`UID SEARCH SINCE ${stamp}`)
        uids = (found.match(/\* SEARCH([^\r\n]*)/)?.[1] ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number)
      } else {
        const found = await client.send("UID SEARCH ALL")
        uids = (found.match(/\* SEARCH([^\r\n]*)/)?.[1] ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean)
          .map(Number)
      }

      for (let i = 0; i < uids.length; i += BATCH) {
        if (transfer.message_limit && copied >= transfer.message_limit) break copy
        if (await cancelled()) return
        const batch = uids.slice(i, i + BATCH)
        const response = await client.send(`UID FETCH ${batch.join(",")} (BODY.PEEK[])`)

        if (await cancelled()) return
        for (const raw of parseFetchedMessages(response)) {
          if (transfer.message_limit && copied >= transfer.message_limit) break copy
          if (transfer.size_limit && BigInt(bytes + raw.length) > transfer.size_limit) break copy

          await deliver({ addressId: address.id, folderId: target.id, raw })
          copied++
          bytes += raw.length
        }

        await update({ messages_done: copied, bytes_done: BigInt(bytes) })
      }

      foldersDone++
      await update({ folders_done: foldersDone, messages_total: copied })
    }

    await client.send("LOGOUT")
    await update({
      status: "done",
      finished_at: new Date(),
      messages_done: copied,
      messages_total: copied,
      bytes_done: BigInt(bytes),
      // The source credential has done its job and is somebody else's secret.
      password_enc: null,
    })
  } finally {
    client.close()
  }
}
