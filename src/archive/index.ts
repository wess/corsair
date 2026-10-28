import { gunzipSync, inflateRawSync } from "node:zlib"

/**
 * Unpacking the attachments that DMARC and TLS reports arrive in: gzip, zip,
 * or nothing at all.
 *
 * Every byte here is from a stranger, and a few kilobytes of deflate expand to
 * gigabytes. So every inflate is bounded by `maxBytes` *while* it runs
 * (`maxOutputLength`, which `Bun.gunzipSync` has no equivalent of), and a zip is
 * read from its central directory with the sizes it declares checked before
 * anything is decompressed. Nothing here trusts a declared size as the bound —
 * it is checked, and then the real inflate is capped again.
 */

export const MAX_REPORT_BYTES = 20 * 1024 * 1024

const fail = (message: string): never => {
  throw new Error(message)
}

const isGzip = (b: Uint8Array): boolean => b.length > 2 && b[0] === 0x1f && b[1] === 0x8b
const isZip = (b: Uint8Array): boolean =>
  b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04

const capped = (inflate: () => Buffer): Buffer => {
  try {
    return inflate()
  } catch (e) {
    if ((e as { code?: string }).code === "ERR_BUFFER_TOO_LARGE")
      fail("Decompressed report is larger than the limit.")
    return fail(`Could not decompress the report: ${(e as Error).message}`)
  }
}

export const gunzipBounded = (bytes: Uint8Array, maxBytes = MAX_REPORT_BYTES): Buffer =>
  capped(() => gunzipSync(bytes, { maxOutputLength: maxBytes }))

type ZipEntry = { name: string; method: number; compressed: number; size: number; offset: number }

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50

/**
 * The entries a zip declares, from its central directory.
 *
 * The end-of-central-directory record is within the last 64 KB + 22 bytes (the
 * comment is at most 65535). Zip64 and multi-disk archives are refused: no
 * reporter sends a report that needs either, and supporting them is surface.
 */
const zipEntries = (buf: Buffer): ZipEntry[] => {
  const floor = Math.max(0, buf.length - 65_557)
  let eocd = -1
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i
      break
    }
  }
  if (eocd === -1) fail("Not a zip archive: no central directory.")

  const count = buf.readUInt16LE(eocd + 10)
  const dirSize = buf.readUInt32LE(eocd + 12)
  const dirOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || dirOffset === 0xffffffff) fail("Zip64 archives are not supported.")
  if (buf.readUInt16LE(eocd + 4) !== 0 || buf.readUInt16LE(eocd + 6) !== 0)
    fail("Multi-disk zip archives are not supported.")
  if (dirOffset + dirSize > buf.length) fail("Zip central directory is out of range.")
  if (count > 16) fail("Zip archive has too many entries for a report.")

  const out: ZipEntry[] = []
  let p = dirOffset
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL)
      fail("Corrupt zip central directory.")
    const flags = buf.readUInt16LE(p + 8)
    if (flags & 0x1) fail("Encrypted zip entries are not supported.")
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    out.push({
      method: buf.readUInt16LE(p + 10),
      compressed: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      name: buf.toString("latin1", p + 46, p + 46 + nameLen),
      offset: buf.readUInt32LE(p + 42),
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const entryData = (buf: Buffer, entry: ZipEntry, maxBytes: number): Buffer => {
  const at = entry.offset
  if (at + 30 > buf.length || buf.readUInt32LE(at) !== LOCAL) fail("Corrupt zip local header.")
  // The local header's own name and extra lengths, which may differ from the
  // central directory's copy.
  const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28)
  const end = start + entry.compressed
  if (end > buf.length) fail("Zip entry runs past the end of the archive.")
  if (entry.size > maxBytes) fail("Decompressed report is larger than the limit.")
  const data = buf.subarray(start, end)
  if (entry.method === 0) return Buffer.from(data)
  if (entry.method !== 8) fail(`Unsupported zip compression method ${entry.method}.`)
  return capped(() => inflateRawSync(data, { maxOutputLength: maxBytes }))
}

/**
 * The files in a zip, decompressed, under one shared byte budget: an archive of
 * many small entries is bounded the same as one large one.
 */
export const unzipBounded = (
  bytes: Uint8Array,
  maxBytes = MAX_REPORT_BYTES,
): { name: string; data: Buffer }[] => {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: { name: string; data: Buffer }[] = []
  let budget = maxBytes
  for (const entry of zipEntries(buf)) {
    if (entry.name.endsWith("/")) continue
    const data = entryData(buf, entry, budget)
    budget -= data.length
    if (budget < 0) fail("Decompressed report is larger than the limit.")
    out.push({ name: entry.name, data })
  }
  return out
}

/**
 * Whatever is inside: a gzip is unwrapped, a zip yields its first file, anything
 * else is returned as it is. Decided by magic bytes rather than the declared
 * content type, which reporters get wrong often enough (zip sent as
 * application/octet-stream, gzip as application/x-gzip) to be no guide.
 */
export const unpack = (bytes: Uint8Array, maxBytes = MAX_REPORT_BYTES): Buffer => {
  if (isGzip(bytes)) return gunzipBounded(bytes, maxBytes)
  if (isZip(bytes)) {
    const first = unzipBounded(bytes, maxBytes)[0]
    if (!first) fail("Zip archive is empty.")
    return first!.data
  }
  if (bytes.length > maxBytes) fail("Report is larger than the limit.")
  return Buffer.from(bytes)
}
