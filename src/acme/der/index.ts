/**
 * The smallest DER encoder a PKCS#10 request needs.
 *
 * Neither node:crypto nor Bun can emit a CSR — `X509Certificate` only parses —
 * and pulling in an ASN.1 library to write one fixed structure is the wrong
 * trade. Everything here is definite-length DER; nothing decodes.
 */

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

const length = (n: number): Uint8Array => {
  if (n < 0x80) return Uint8Array.of(n)
  const bytes: number[] = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff)
  return Uint8Array.of(0x80 | bytes.length, ...bytes)
}

export const tlv = (tag: number, ...content: Uint8Array[]): Uint8Array => {
  const body = concat(content)
  return concat([Uint8Array.of(tag), length(body.length), body])
}

export const sequence = (...items: Uint8Array[]) => tlv(0x30, ...items)
export const set = (...items: Uint8Array[]) => tlv(0x31, ...items)
export const octets = (bytes: Uint8Array) => tlv(0x04, bytes)
export const utf8 = (s: string) => tlv(0x0c, new TextEncoder().encode(s))
export const nul = () => Uint8Array.of(0x05, 0x00)

/** No unused bits: every signature and key this file writes is whole bytes. */
export const bits = (bytes: Uint8Array) => tlv(0x03, Uint8Array.of(0), bytes)

/** Context-specific tag `[n]`; `constructed` for a wrapper, primitive for an implicit string. */
export const context = (n: number, constructed: boolean, ...content: Uint8Array[]) =>
  tlv(0x80 | (constructed ? 0x20 : 0) | n, ...content)

/** Non-negative integers only, which is all a version number or serial needs. */
export const integer = (value: number | Uint8Array): Uint8Array => {
  let bytes: number[]
  if (typeof value === "number") {
    bytes = []
    for (let v = value; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff)
    if (bytes.length === 0) bytes = [0]
  } else {
    bytes = [...value]
    while (bytes.length > 1 && bytes[0] === 0 && (bytes[1] as number) < 0x80) bytes.shift()
  }
  // A set top bit would read as negative.
  if ((bytes[0] as number) >= 0x80) bytes.unshift(0)
  return tlv(0x02, Uint8Array.from(bytes))
}

export const oid = (dotted: string): Uint8Array => {
  const parts = dotted.split(".").map(Number)
  const [a = 0, b = 0, ...rest] = parts
  const out = [a * 40 + b]
  for (const arc of rest) {
    const chunk: number[] = [arc & 0x7f]
    for (let v = Math.floor(arc / 128); v > 0; v = Math.floor(v / 128))
      chunk.unshift(0x80 | (v & 0x7f))
    out.push(...chunk)
  }
  return tlv(0x06, Uint8Array.from(out))
}

export const pem = (label: string, der: Uint8Array): string => {
  const b64 = Buffer.from(der).toString("base64")
  const lines = b64.match(/.{1,64}/g) ?? []
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`
}
