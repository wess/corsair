import { config } from "../config/index.ts"
import { db } from "../db/index.ts"

export const webmailUrl = (domain: string): string | null =>
  config.mail.webmail ? `https://webmail.${domain}` : null

export const webmailDomain = (host: string): string | null => {
  if (!config.mail.webmail) return null
  const name = host.toLowerCase().replace(/\.$/, "")
  if (!/^webmail\.(?=.{1,245}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(name))
    return null
  return name.slice(8)
}

export const allowsWebmailHost = async (host: string): Promise<boolean> => {
  const domain = webmailDomain(host)
  if (!domain) return false
  const row = await db().one<{ id: string }>({
    text: "SELECT id FROM domains WHERE name = $1 AND status = 'active'",
    values: [domain],
  })
  return Boolean(row)
}
