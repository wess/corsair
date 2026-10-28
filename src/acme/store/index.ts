import { createPrivateKey, type KeyObject, X509Certificate } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { generateKey } from "../jws/index.ts"

/**
 * Files under `ACME_DIR`:
 *
 * - `account.key` — the ACME account key. Losing it costs nothing but a new
 *   account; it is not stored anywhere else.
 * - `certificate.pem` — the certificate's private key followed by the chain, in
 *   one file. One file is what makes replacing it atomic: written beside and
 *   renamed over, so a crash mid-renewal leaves the old pair or the new pair,
 *   never a new chain with the old key, which every handshake would fail.
 *
 * Both are 0600. The directory is 0700.
 */

export type StoredCertificate = {
  /** The leaf and its intermediates, PEM. */
  chain: string
  key: string
  notAfter: Date
  names: string[]
}

const ACCOUNT = "account.key"
const CERTIFICATE = "certificate.pem"

export const certificateFile = (dir: string): string => join(dir, CERTIFICATE)

const writeAtomic = async (path: string, data: string): Promise<void> => {
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, data, { mode: 0o600 })
  await rename(tmp, path)
}

const ensureDir = (dir: string) => mkdir(dir, { recursive: true, mode: 0o700 })

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT"

export const loadAccountKey = async (dir: string): Promise<KeyObject> => {
  try {
    return createPrivateKey(await readFile(join(dir, ACCOUNT), "latin1"))
  } catch (e) {
    if (!missing(e)) throw e
  }
  await ensureDir(dir)
  const key = generateKey()
  await writeAtomic(join(dir, ACCOUNT), key.export({ type: "pkcs8", format: "pem" }) as string)
  return key
}

const PEM_BLOCK = /-----BEGIN ([A-Z ]+)-----[\s\S]+?-----END \1-----\n?/g

/** Splits a combined file into the TLS options Bun takes, and checks they belong together. */
export const parseCertificate = (pem: string): StoredCertificate => {
  const blocks = [...pem.matchAll(PEM_BLOCK)]
  const key = blocks.find((b) => (b[1] as string).endsWith("PRIVATE KEY"))?.[0]
  const certs = blocks.filter((b) => b[1] === "CERTIFICATE").map((b) => b[0].trimEnd())
  if (!key || certs.length === 0) throw new Error("certificate.pem needs a private key and a chain")
  const chain = `${certs.join("\n")}\n`
  const leaf = new X509Certificate(certs[0] as string)
  if (!leaf.checkPrivateKey(createPrivateKey(key))) {
    throw new Error("certificate.pem holds a key that does not match its certificate")
  }
  const names = (leaf.subjectAltName ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.startsWith("DNS:"))
    .map((s) => s.slice(4).toLowerCase())
  return { chain, key: `${key.trimEnd()}\n`, notAfter: new Date(leaf.validTo), names }
}

export const readCertificate = async (dir: string): Promise<StoredCertificate | null> => {
  let pem: string
  try {
    pem = await readFile(certificateFile(dir), "latin1")
  } catch (e) {
    if (missing(e)) return null
    throw e
  }
  return parseCertificate(pem)
}

/** Validates before writing, so a bad download can never replace a working pair. */
export const writeCertificate = async (
  dir: string,
  key: KeyObject,
  chain: string,
): Promise<StoredCertificate> => {
  const pem = `${key.export({ type: "pkcs8", format: "pem" }) as string}${chain.trimEnd()}\n`
  const parsed = parseCertificate(pem)
  await ensureDir(dir)
  await writeAtomic(certificateFile(dir), pem)
  return parsed
}
