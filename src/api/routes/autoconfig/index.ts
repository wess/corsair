import { get, post, type Route, text } from "@atlas/server"
import { config } from "../../../config/index.ts"
import { canUpgradeServerSocketToTls } from "../../../starttls/index.ts"

/**
 * Automatic mail-client configuration.
 *
 * Three incompatible mechanisms, because three vendors each invented their own:
 * Thunderbird fetches an XML document from `autoconfig.<domain>`, Outlook POSTs
 * to `autodiscover.<domain>`, and Apple Mail follows the MTA-STS policy for the
 * hostname. Serving all three is the difference between a customer typing an
 * address and a customer typing six hostnames and port numbers.
 */

const xml = (conn: Parameters<typeof text>[0], body: string) => {
  const response = text(conn, 200, body)
  return {
    ...response,
    respHeaders: new Headers([
      ...response.respHeaders,
      ["content-type", "application/xml; charset=utf-8"],
    ]),
  }
}

const domainOf = (url: string): string => {
  const value = new URL(url).searchParams.get("emailaddress") ?? ""
  const at = value.lastIndexOf("@")
  return at === -1 ? "" : value.slice(at + 1)
}

export const autoconfigRoutes: Route[] = [
  // Thunderbird and anything else using the Mozilla ISPDB format.
  get("/mail/config-v1.1.xml", (c) => {
    const domain = domainOf(c.request.url) || "%EMAILDOMAIN%"
    return xml(
      c,
      `<?xml version="1.0" encoding="UTF-8"?>
<clientConfig version="1.1">
  <emailProvider id="${domain}">
    <domain>${domain}</domain>
    <displayName>Corsair Mail</displayName>
    <displayShortName>Corsair</displayShortName>
    <incomingServer type="imap">
      <hostname>${config.mail.imap}</hostname>
      <port>993</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <incomingServer type="pop3">
      <hostname>${config.mail.pop}</hostname>
      <port>995</port>
      <socketType>SSL</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </incomingServer>
    <outgoingServer type="smtp">
      <hostname>${config.mail.smtp}</hostname>
      <port>587</port>
      <socketType>STARTTLS</socketType>
      <authentication>password-cleartext</authentication>
      <username>%EMAILADDRESS%</username>
    </outgoingServer>
  </emailProvider>
</clientConfig>
`,
    )
  }),

  // Outlook. The request body names the address; the response shape is fixed.
  post("/autodiscover/autodiscover.xml", async (c) => {
    let address = "%EMAILADDRESS%"
    try {
      const body = await c.request.text()
      address = body.match(/<EMailAddress>([^<]+)<\/EMailAddress>/i)?.[1] ?? address
    } catch {
      // A malformed body still gets a usable document with the placeholder.
    }

    return xml(
      c,
      `<?xml version="1.0" encoding="utf-8"?>
<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">
  <Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">
    <Account>
      <AccountType>email</AccountType>
      <Action>settings</Action>
      <Protocol>
        <Type>IMAP</Type>
        <Server>${config.mail.imap}</Server>
        <Port>993</Port>
        <SSL>on</SSL>
        <SPA>off</SPA>
        <AuthRequired>on</AuthRequired>
        <LoginName>${address}</LoginName>
      </Protocol>
      <Protocol>
        <Type>SMTP</Type>
        <Server>${config.mail.smtp}</Server>
        <Port>587</Port>
        <SSL>on</SSL>
        <Encryption>TLS</Encryption>
        <SPA>off</SPA>
        <AuthRequired>on</AuthRequired>
        <LoginName>${address}</LoginName>
      </Protocol>
    </Account>
  </Response>
</Autodiscover>
`,
    )
  }),

  /**
   * MTA-STS (RFC 8461). A sending server fetches this over HTTPS and, once it
   * has, refuses to deliver to this host without TLS — which is what closes the
   * downgrade attack STARTTLS alone leaves open.
   *
   * The mode tracks what the MX can actually do. An MTA-STS policy is a promise
   * that this host will answer STARTTLS on port 25, and this runtime cannot:
   * Bun has no server-side TLS upgrade, so port 25 does not advertise it (see
   * `src/starttls`). Publishing `testing` regardless would advertise a
   * capability that is not there — every MTA-STS-aware sender would attempt
   * TLS, fail, and file a report, for a policy nobody could ever safely move to
   * `enforce`. `none` is the value RFC 8461 defines for exactly this: a policy
   * that is published and deliberately not in effect.
   *
   * The moment STARTTLS works, this becomes `testing` on its own, and an
   * operator who has watched the reports moves it to `enforce`. Going straight
   * to `enforce` with a wrong MX list silently blackholes mail.
   */
  get("/.well-known/mta-sts.txt", (c) => {
    const response = text(
      c,
      200,
      [
        "version: STSv1",
        `mode: ${canUpgradeServerSocketToTls() ? "testing" : "none"}`,
        `mx: ${config.mail.mx}`,
        "max_age: 604800",
        "",
      ].join("\n"),
    )
    return {
      ...response,
      respHeaders: new Headers([
        ...response.respHeaders,
        ["content-type", "text/plain; charset=utf-8"],
      ]),
    }
  }),

  get("/.well-known/security.txt", (c) => {
    const response = text(
      c,
      200,
      [
        `Contact: mailto:security@${new URL(config.publicUrl).hostname}`,
        "Preferred-Languages: en",
        `Canonical: ${config.publicUrl}/.well-known/security.txt`,
        "",
      ].join("\n"),
    )
    return {
      ...response,
      respHeaders: new Headers([
        ...response.respHeaders,
        ["content-type", "text/plain; charset=utf-8"],
      ]),
    }
  }),
]
