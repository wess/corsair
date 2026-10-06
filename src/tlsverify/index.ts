import { checkServerIdentity } from "node:tls"

export const peerError = (
  socket: Bun.Socket<unknown>,
  host: string,
  error: Error | null,
): Error | null => {
  if (error) return error
  if (!socket.authorized)
    return socket.getAuthorizationError() ?? new Error("The TLS certificate was not authorized.")
  return checkServerIdentity(host.replace(/^\[|\]$/g, ""), socket.getPeerCertificate()) ?? null
}
