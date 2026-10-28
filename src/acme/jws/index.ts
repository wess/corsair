import { createHash, createPublicKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto"

export type Jwk = Record<string, string>

export const b64url = (data: Uint8Array | string): string =>
  Buffer.from(typeof data === "string" ? new TextEncoder().encode(data) : data).toString(
    "base64url",
  )

/** P-256: what ES256 means, and what every ACME server accepts. */
export const generateKey = (): KeyObject =>
  generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey

/** The public half only. Exporting the private key's JWK would include `d`. */
export const publicJwk = (key: KeyObject): Jwk => {
  // Bun's createPublicKey refuses a key that is already public; node accepts it.
  const pub = key.type === "public" ? key : createPublicKey(key)
  const jwk = pub.export({ format: "jwk" }) as Jwk
  return jwk.kty === "EC"
    ? { crv: jwk.crv as string, kty: "EC", x: jwk.x as string, y: jwk.y as string }
    : jwk
}

// RFC 7638 §3.2: only the required members, in lexicographic order.
const REQUIRED: Record<string, string[]> = {
  EC: ["crv", "kty", "x", "y"],
  RSA: ["e", "kty", "n"],
  OKP: ["crv", "kty", "x"],
}

/**
 * RFC 7638 thumbprint. Half of every HTTP-01 key authorization, so a member out
 * of order or one extra field makes every challenge fail validation with a
 * message about the token, not the key.
 */
export const thumbprint = (jwk: Jwk): string => {
  const members = REQUIRED[jwk.kty as string]
  if (!members) throw new Error(`No thumbprint rule for key type ${jwk.kty}`)
  const canonical = `{${members.map((m) => `${JSON.stringify(m)}:${JSON.stringify(jwk[m])}`).join(",")}}`
  return b64url(createHash("sha256").update(canonical).digest())
}

export const keyAuthorization = (token: string, key: KeyObject): string =>
  `${token}.${thumbprint(publicJwk(key))}`

/**
 * A flattened JWS (RFC 8555 §6.2). `kid` once the account exists, `jwk` before
 * — newAccount is the only request that may carry the key itself.
 *
 * `payload: null` is POST-as-GET, whose payload is the empty string rather than
 * `{}`; the two mean different things to the server.
 */
export const signJws = (input: {
  key: KeyObject
  url: string
  nonce: string
  payload: unknown
  kid?: string
}): { protected: string; payload: string; signature: string } => {
  const header = {
    alg: "ES256",
    nonce: input.nonce,
    url: input.url,
    ...(input.kid ? { kid: input.kid } : { jwk: publicJwk(input.key) }),
  }
  const protectedB64 = b64url(JSON.stringify(header))
  const payloadB64 = input.payload === null ? "" : b64url(JSON.stringify(input.payload))
  // JWS wants the raw r||s pair, not the DER SEQUENCE node produces by default.
  const signature = sign("sha256", new TextEncoder().encode(`${protectedB64}.${payloadB64}`), {
    key: input.key,
    dsaEncoding: "ieee-p1363",
  })
  return { protected: protectedB64, payload: payloadB64, signature: b64url(signature) }
}
