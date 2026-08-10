import { createDecipheriv, createHash } from "node:crypto"
import { from } from "@atlas/db"
import { folderBySpecialUse } from "../../addresses/index.ts"
import { config } from "../../config/index.ts"
import { db } from "../../db/index.ts"
import { uidValidity } from "../../ids/index.ts"
import {
  type Address,
  addresses,
  type Folder,
  folders,
  type Transfer,
  transfers,
} from "../../schema/index.ts"
import { deliver } from "../../store/index.ts"

/**
 * Migrates a mailbox from another host over IMAP.
 *
 * A minimal IMAP *client* rather than a library: the operations needed are
 * LIST, SELECT, and a UID FETCH loop, and the awkward parts (literal framing,
 * multi-line responses) are the same ones the server side already models.
 */

const CRLF = "\r\n"

export const decryptPassword = (encrypted: string): string => {
  const [ivHex, tagHex, payload] = encrypted.split(":")
  if (!ivHex || !tagHex || !payload) return ""
  const key = createHash("sha256").update(config.jwtSecret).digest()
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"))
  decipher.setAuthTag(Buffer.from(tagHex, "hex"))
  return decipher.update(payload, "base64", "utf8") + decipher.final("utf8")
}

type Client = {
  send: (command: string) => Promise<string>
  close: () => void
}

const connect = async (input: {
  host: string
  port: number
  secure: boolean
  timeoutMs: number
}): Promise<Client> => {
  let buffer = ""
  let closed = false
  let notify: (() => void) | null = null

  const socket = await Bun.connect({
    hostname: input.host,
    port: input.port,
    ...(input.secure ? { tls: { rejectUnauthorized: false } } : {}),
    socket: {
      data(_s: unknown, data: Uint8Array) {
        buffer += Buffer.from(data).toString("latin1")
        notify?.()
      },
      close() {
        closed = true
        notify?.()
      },
      error() {
        closed = true
        notify?.()
      },
    } as never,
  })

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
    const pattern = new RegExp(`^${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`, "m")
    while (true) {
      const match = buffer.match(pattern)
      if (match) {
        const end = (match.index ?? 0) + match[0].length
        const out = buffer.slice(0, end)
        buffer = buffer.slice(end)
        return out
      }
      if (closed) throw new Error("the remote server closed the connection")
      if (Date.now() > deadline) throw new Error("timed out waiting for the remote server")
      await new Promise<void>((resolve) => {
        notify = resolve
        setTimeout(resolve, 200)
      })
      notify = null
    }
  }

  // Consume the greeting before the first command.
  await new Promise<void>((resolve) => {
    const start = Date.now()
    const check = () => {
      if (buffer.includes(CRLF) || closed || Date.now() - start > input.timeoutMs) {
        buffer = ""
        resolve()
        return
      }
      setTimeout(check, 50)
    }
    check()
  })

  return {
    send: async (command) => {
      const tag = `c${++counter}`
      socket.write(`${tag} ${command}${CRLF}`)
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

const quote = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

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

const BATCH = 20

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
        .where((q) => q("id").equals(transfer.id))
        .update({ ...patch, updated_at: new Date() }),
    )

  await update({ status: "running", started_at: new Date(), last_error: null })

  const client = await connect({
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

    for (const remote of remoteFolders) {
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
        if (transfer.message_limit && copied >= transfer.message_limit) break
        const batch = uids.slice(i, i + BATCH)
        const response = await client.send(`UID FETCH ${batch.join(",")} (BODY.PEEK[])`)

        for (const raw of parseFetchedMessages(response)) {
          if (transfer.message_limit && copied >= transfer.message_limit) break
          if (transfer.size_limit && BigInt(bytes + raw.length) > transfer.size_limit) break

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
