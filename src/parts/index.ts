import { notFound } from "../errors/index.ts"
import * as mime from "../mime/index.ts"

/**
 * One MIME part as an HTTP response, for attachment download.
 *
 * The declared type is not trusted for rendering. Serving an attacker-supplied
 * `text/html` attachment inline on this origin would hand it whatever the
 * origin can reach, so everything except an inline image is an opaque download,
 * sandboxed, with sniffing off.
 */
export const partResponse = (raw: string, section: string, inlineImages: boolean): Response => {
  const parsed = mime.parseMessage(raw)
  const part = mime.findPart(parsed, section)
  if (!part) throw notFound("No such part.")

  const bytes = mime.decodeTransfer(raw.slice(part.bodyStart, part.end), part.encoding)
  const filename = part.disposition?.params.filename ?? part.params.name ?? `part-${part.section}`
  const inline = inlineImages && part.disposition?.type === "inline" && part.type === "image"

  // Copied into a fresh Uint8Array: a Buffer view can share a larger
  // ArrayBuffer, and Response would then serve the neighbouring bytes.
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type":
        part.type === "image" ? `${part.type}/${part.subtype}` : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${mime.stripControls(filename).replace(/"/g, "")}"`,
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  })
}
