import { createPublicKey, type KeyObject, sign } from "node:crypto"
import { bits, context, integer, octets, oid, sequence, set, utf8 } from "../der/index.ts"

const ECDSA_SHA256 = "1.2.840.10045.4.3.2"
const COMMON_NAME = "2.5.4.3"
const EXTENSION_REQUEST = "1.2.840.113549.1.9.14"
const SUBJECT_ALT_NAME = "2.5.29.17"

/**
 * A PKCS#10 certification request (RFC 2986) for `domains`, signed by `key`.
 *
 * The names that matter go in subjectAltName; ACME servers ignore the subject.
 * The first name also goes in CN when it fits, because some clients still read
 * it — and is left out when it does not, since a CN over 64 characters is
 * invalid and Let's Encrypt refuses the whole request over it.
 */
export const buildCsr = (domains: string[], key: KeyObject): Uint8Array => {
  if (domains.length === 0) throw new Error("A certificate needs at least one name.")
  const [first = ""] = domains

  const subject =
    first.length <= 64 ? sequence(set(sequence(oid(COMMON_NAME), utf8(first)))) : sequence()

  const spki = new Uint8Array(createPublicKey(key).export({ type: "spki", format: "der" }))

  const san = sequence(...domains.map((d) => context(2, false, new TextEncoder().encode(d))))
  const extensions = sequence(sequence(oid(SUBJECT_ALT_NAME), octets(san)))
  const attributes = context(0, true, sequence(oid(EXTENSION_REQUEST), set(extensions)))

  const info = sequence(integer(0), subject, spki, attributes)
  // node's default ECDSA encoding is the DER SEQUENCE { r, s } X.509 wants.
  const signature = new Uint8Array(sign("sha256", info, key))

  return sequence(info, sequence(oid(ECDSA_SHA256)), bits(signature))
}
