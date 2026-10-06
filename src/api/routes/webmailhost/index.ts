import { getR, type Route, text } from "@atlas/server"
import { allowsWebmailHost } from "../../../webmailhost/index.ts"

// the HTTPS proxy asks before issuing a certificate; fail closed on unknown names
export const webmailHostRoutes: Route[] = [
  getR("/api/webmail/host", { assigns: {} as never }, async (c) =>
    text(c, (await allowsWebmailHost(String(c.query?.domain ?? ""))) ? 200 : 403, ""),
  ),
]
