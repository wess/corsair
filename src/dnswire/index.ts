import { createWriter, type SocketWriter } from "../socketio/index.ts"

/**
 * Just enough of the DNS wire format to ask a validating resolver a question and
 * read its AD bit.
 *
 * It exists because `node:dns` answers with records and nothing else: no header,
 * no AD flag, no way to tell a DNSSEC-authenticated answer from a forged one.
 * DANE is meaningless without that distinction, so the outbound path asks its
 * questions here instead. Only the types DANE needs are decoded (A, AAAA, CNAME,
 * MX, TLSA); everything else is carried as raw rdata.
 */

export const TYPE = {
  A: 1,
  CNAME: 5,
  SOA: 6,
  MX: 15,
  AAAA: 28,
  OPT: 41,
  TLSA: 52,
} as const

export const RCODE = { NOERROR: 0, FORMERR: 1, SERVFAIL: 2, NXDOMAIN: 3, REFUSED: 5 } as const

export type Tlsa = { usage: number; selector: number; matchingType: number; data: Uint8Array }

export type Answer = {
  name: string
  type: number
  class: number
  ttl: number
  rdata: Uint8Array
  /** Set for MX. */
  mx?: { preference: number; exchange: string }
  /** Set for CNAME. */
  target?: string
  /** Set for A and AAAA. */
  address?: string
  /** Set for TLSA. */
  tlsa?: Tlsa
}

export type Flags = {
  qr: boolean
  opcode: number
  aa: boolean
  tc: boolean
  rd: boolean
  ra: boolean
  /** Authenticated Data: the resolver validated every record in the answer. */
  ad: boolean
  cd: boolean
}

export type Message = {
  id: number
  flags: Flags
  rcode: number
  questions: { name: string; type: number; class: number }[]
  answers: Answer[]
  authority: Answer[]
  additional: Answer[]
}

/** Names compare case-insensitively and with or without the root dot. */
export const canonicalName = (name: string): string => name.replace(/\.$/, "").toLowerCase()

const encodeName = (name: string): number[] => {
  const trimmed = name.replace(/\.$/, "")
  const out: number[] = []
  if (trimmed) {
    for (const label of trimmed.split(".")) {
      const bytes = Buffer.from(label, "latin1")
      if (bytes.length === 0 || bytes.length > 63) throw new Error(`Bad DNS label in ${name}.`)
      out.push(bytes.length, ...bytes)
    }
  }
  out.push(0)
  if (out.length > 255) throw new Error(`DNS name too long: ${name}.`)
  return out
}

const u16 = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff]
const u32 = (n: number): number[] => [
  (n >>> 24) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 8) & 0xff,
  n & 0xff,
]

export type EncodeInput = {
  id: number
  flags?: Partial<Flags>
  rcode?: number
  questions: { name: string; type: number }[]
  answers?: { name: string; type: number; ttl?: number; rdata: Uint8Array }[]
  /** Adds an EDNS0 OPT record; `dnssecOk` sets its DO bit. */
  edns?: { udpSize: number; dnssecOk: boolean }
}

/**
 * Encodes a message. Names are never compressed on the way out — the decoder
 * handles compression because every resolver uses it, but nothing here is large
 * enough to need it.
 */
export const encodeMessage = (input: EncodeInput): Uint8Array => {
  const f = input.flags ?? {}
  const flags =
    (f.qr ? 0x8000 : 0) |
    ((f.opcode ?? 0) << 11) |
    (f.aa ? 0x0400 : 0) |
    (f.tc ? 0x0200 : 0) |
    (f.rd ? 0x0100 : 0) |
    (f.ra ? 0x0080 : 0) |
    (f.ad ? 0x0020 : 0) |
    (f.cd ? 0x0010 : 0) |
    ((input.rcode ?? 0) & 0x0f)
  const answers = input.answers ?? []
  const out: number[] = [
    ...u16(input.id),
    ...u16(flags),
    ...u16(input.questions.length),
    ...u16(answers.length),
    ...u16(0),
    ...u16(input.edns ? 1 : 0),
  ]
  for (const q of input.questions) out.push(...encodeName(q.name), ...u16(q.type), ...u16(1))
  for (const a of answers) {
    out.push(...encodeName(a.name), ...u16(a.type), ...u16(1), ...u32(a.ttl ?? 300))
    out.push(...u16(a.rdata.length), ...a.rdata)
  }
  if (input.edns) {
    // Root name, OPT, the UDP size in CLASS, and DO as the top bit of the TTL's
    // flags half (RFC 6891 §6.1.3, RFC 3225).
    out.push(0, ...u16(TYPE.OPT), ...u16(input.edns.udpSize), 0, 0)
    out.push(...u16(input.edns.dnssecOk ? 0x8000 : 0), ...u16(0))
  }
  return Uint8Array.from(out)
}

/**
 * A query asking for DNSSEC: DO in EDNS so the resolver validates, and AD in the
 * header so it reports the result (RFC 6840 §5.7) — without AD set a resolver
 * may leave it clear on a validated answer to an old-style client.
 */
export const encodeQuery = (input: { id: number; name: string; type: number }): Uint8Array =>
  encodeMessage({
    id: input.id,
    flags: { rd: true, ad: true },
    questions: [{ name: input.name, type: input.type }],
    edns: { udpSize: 1232, dnssecOk: true },
  })

const readName = (bytes: Uint8Array, start: number): { name: string; next: number } => {
  const labels: string[] = []
  let offset = start
  let next = -1
  let jumps = 0
  let length = 0
  while (true) {
    if (offset >= bytes.length) throw new Error("DNS name runs past the message.")
    const len = bytes[offset] as number
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= bytes.length) throw new Error("DNS pointer runs past the message.")
      if (++jumps > 64) throw new Error("DNS compression loop.")
      if (next === -1) next = offset + 2
      offset = ((len & 0x3f) << 8) | (bytes[offset + 1] as number)
      continue
    }
    if (len & 0xc0) throw new Error("Unsupported DNS label type.")
    if (len === 0) {
      if (next === -1) next = offset + 1
      break
    }
    if (offset + 1 + len > bytes.length) throw new Error("DNS label runs past the message.")
    length += len + 1
    if (length > 255) throw new Error("DNS name too long.")
    labels.push(Buffer.from(bytes.subarray(offset + 1, offset + 1 + len)).toString("latin1"))
    offset += 1 + len
  }
  return { name: labels.join("."), next }
}

const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

const ipv6 = (b: Uint8Array): string => {
  const parts: string[] = []
  for (let i = 0; i < 16; i += 2)
    parts.push((((b[i] as number) << 8) | (b[i + 1] as number)).toString(16))
  return parts.join(":")
}

const readRecord = (bytes: Uint8Array, start: number): { answer: Answer; next: number } => {
  const { name, next: afterName } = readName(bytes, start)
  if (afterName + 10 > bytes.length) throw new Error("DNS record header runs past the message.")
  const dv = view(bytes)
  const type = dv.getUint16(afterName)
  const klass = dv.getUint16(afterName + 2)
  const ttl = dv.getUint32(afterName + 4)
  const rdlength = dv.getUint16(afterName + 8)
  const rstart = afterName + 10
  const rend = rstart + rdlength
  if (rend > bytes.length) throw new Error("DNS rdata runs past the message.")
  const rdata = bytes.subarray(rstart, rend)
  const answer: Answer = { name, type, class: klass, ttl, rdata }

  if (type === TYPE.MX) {
    if (rdlength < 3) throw new Error("Short MX record.")
    // The exchange may be compressed against the whole message, so it is read
    // from the message rather than from the rdata slice.
    answer.mx = { preference: dv.getUint16(rstart), exchange: readName(bytes, rstart + 2).name }
  } else if (type === TYPE.CNAME) {
    answer.target = readName(bytes, rstart).name
  } else if (type === TYPE.A && rdlength === 4) {
    answer.address = Array.from(rdata).join(".")
  } else if (type === TYPE.AAAA && rdlength === 16) {
    answer.address = ipv6(rdata)
  } else if (type === TYPE.TLSA) {
    if (rdlength < 3) throw new Error("Short TLSA record.")
    answer.tlsa = {
      usage: rdata[0] as number,
      selector: rdata[1] as number,
      matchingType: rdata[2] as number,
      data: Uint8Array.from(rdata.subarray(3)),
    }
  }
  return { answer, next: rend }
}

export const decodeMessage = (bytes: Uint8Array): Message => {
  if (bytes.length < 12) throw new Error("DNS message shorter than its header.")
  const dv = view(bytes)
  const raw = dv.getUint16(2)
  const counts = [dv.getUint16(4), dv.getUint16(6), dv.getUint16(8), dv.getUint16(10)] as const
  let offset = 12
  const questions: Message["questions"] = []
  for (let i = 0; i < counts[0]; i++) {
    const { name, next } = readName(bytes, offset)
    if (next + 4 > bytes.length) throw new Error("DNS question runs past the message.")
    questions.push({ name, type: dv.getUint16(next), class: dv.getUint16(next + 2) })
    offset = next + 4
  }
  const section = (count: number): Answer[] => {
    const out: Answer[] = []
    for (let i = 0; i < count; i++) {
      const { answer, next } = readRecord(bytes, offset)
      out.push(answer)
      offset = next
    }
    return out
  }
  const answers = section(counts[1])
  const authority = section(counts[2])
  const additional = section(counts[3])
  return {
    id: dv.getUint16(0),
    flags: {
      qr: Boolean(raw & 0x8000),
      opcode: (raw >> 11) & 0x0f,
      aa: Boolean(raw & 0x0400),
      tc: Boolean(raw & 0x0200),
      rd: Boolean(raw & 0x0100),
      ra: Boolean(raw & 0x0080),
      ad: Boolean(raw & 0x0020),
      cd: Boolean(raw & 0x0010),
    },
    rcode: raw & 0x0f,
    questions,
    answers,
    authority,
    additional,
  }
}

export type Server = { host: string; port: number }

const randomId = (): number => crypto.getRandomValues(new Uint16Array(1))[0] as number

/**
 * A reply answers our query only if it echoes the id and the question. Checking
 * the id alone leaves 16 bits between an off-path spoofer and the answer; with
 * the question as well they also have to guess what was asked.
 */
const answersQuery = (reply: Message, id: number, name: string, type: number): boolean => {
  const q = reply.questions[0]
  return (
    reply.flags.qr &&
    reply.id === id &&
    reply.questions.length === 1 &&
    q !== undefined &&
    q.type === type &&
    canonicalName(q.name) === canonicalName(name)
  )
}

const overUdp = (
  server: Server,
  query: Uint8Array,
  accept: (m: Message) => boolean,
  timeoutMs: number,
) =>
  new Promise<Message>((resolve, reject) => {
    let done = false
    let socket: {
      close: () => void
      send: (d: Uint8Array, port: number, host: string) => boolean
    } | null = null
    const finish = (error: Error | null, message?: Message) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket?.close()
      if (error) reject(error)
      else resolve(message as Message)
    }
    const timer = setTimeout(
      () => finish(new Error(`DNS query to ${server.host} timed out.`)),
      timeoutMs,
    )
    Bun.udpSocket({
      hostname: server.host.includes(":") ? "::" : "0.0.0.0",
      socket: {
        data(_s, data, port, address) {
          // Datagrams from anywhere but the resolver are ignored, not trusted.
          if (port !== server.port || address.replace(/^::ffff:/, "") !== server.host) return
          try {
            const message = decodeMessage(new Uint8Array(data))
            if (accept(message)) finish(null, message)
          } catch {
            // A malformed datagram is not an answer; keep waiting for one.
          }
        },
        error(_s, error) {
          finish(error)
        },
      },
    })
      .then((s) => {
        socket = s
        if (done) s.close()
        else s.send(query, server.port, server.host)
      })
      .catch((e) => finish(e as Error))
  })

const overTcp = (
  server: Server,
  query: Uint8Array,
  accept: (m: Message) => boolean,
  timeoutMs: number,
) =>
  new Promise<Message>((resolve, reject) => {
    let done = false
    let buffer = Buffer.alloc(0)
    let end: (() => void) | null = null
    let writer: SocketWriter | null = null
    const finish = (error: Error | null, message?: Message) => {
      if (done) return
      done = true
      clearTimeout(timer)
      end?.()
      if (error) reject(error)
      else resolve(message as Message)
    }
    const timer = setTimeout(
      () => finish(new Error(`DNS query to ${server.host} timed out.`)),
      timeoutMs,
    )
    Bun.connect({
      hostname: server.host,
      port: server.port,
      socket: {
        data(_s, data) {
          buffer = Buffer.concat([buffer, Buffer.from(data)])
          if (buffer.length > 65537) return finish(new Error("DNS reply too large."))
          if (buffer.length < 2) return
          const length = buffer.readUInt16BE(0)
          if (buffer.length < 2 + length) return
          try {
            const message = decodeMessage(new Uint8Array(buffer.subarray(2, 2 + length)))
            if (accept(message)) finish(null, message)
            else finish(new Error("DNS reply did not match the query."))
          } catch (e) {
            finish(e as Error)
          }
        },
        close() {
          finish(new Error("DNS connection closed before a reply."))
        },
        error(_s, error) {
          finish(error)
        },
        drain() {
          writer?.drain()
        },
      },
    })
      .then((socket) => {
        end = () => {
          writer?.close()
          socket.end()
        }
        if (done) return socket.end()
        writer = createWriter(() => socket)
        const framed = new Uint8Array(query.length + 2)
        framed.set([(query.length >> 8) & 0xff, query.length & 0xff])
        framed.set(query, 2)
        writer.write(framed)
      })
      .catch((e) => finish(e as Error))
  })

/**
 * Asks `server` one question. UDP first; a truncated reply is asked again over
 * TCP (RFC 7766), which a TLSA RRset with its signatures can easily need.
 */
export const query = async (input: {
  server: Server
  name: string
  type: number
  timeoutMs?: number
}): Promise<Message> => {
  const timeoutMs = input.timeoutMs ?? 5000
  const id = randomId()
  const packet = encodeQuery({ id, name: input.name, type: input.type })
  const accept = (m: Message) => answersQuery(m, id, input.name, input.type)
  const reply = await overUdp(input.server, packet, accept, timeoutMs)
  if (!reply.flags.tc) return reply
  return overTcp(input.server, packet, accept, timeoutMs)
}
