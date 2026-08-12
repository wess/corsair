import { getR, json, type Route } from "@atlas/server"
import { config } from "../../../config/index.ts"
import { db } from "../../../db/index.ts"
import { formatBytes, usageOf } from "../../../plans/index.ts"
import { entitlementObject } from "../../../serialize/index.ts"
import { startTlsOffered } from "../../../starttls/index.ts"
import { authedWithPlan, entitlementFrom, principalOf } from "../../pipes/index.ts"

/**
 * The Overview screen, in one request.
 *
 * Assembled server-side rather than by the panel making six calls: everything
 * here is a small aggregate over the same account, and the round trips would
 * dominate the cost.
 */
export const dashboardRoutes: Route[] = [
  getR("/api/overview", { before: authedWithPlan, assigns: {} as never }, async (c) => {
    const userId = principalOf(c).userId
    const usage = await usageOf(userId)

    const activity = await db().all<{ day: string; direction: string; count: string }>({
      text: `SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
                    direction, count(*)::text AS count
               FROM mail_log
              WHERE user_id = $1 AND created_at > now() - interval '30 days'
              GROUP BY 1, 2 ORDER BY 1`,
      values: [userId],
    })

    const days: Record<string, { sent: number; received: number }> = {}
    for (let i = 29; i >= 0; i--) {
      const key = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
      days[key] = { sent: 0, received: 0 }
    }
    for (const row of activity) {
      const bucket = days[row.day]
      if (!bucket) continue
      if (row.direction === "outbound") bucket.sent = Number(row.count)
      else bucket.received = Number(row.count)
    }

    const topSenders = await db().all<{ email: string; sent: string }>({
      text: `SELECT a.local_part || '@' || d.name AS email,
                    count(l.id) FILTER (WHERE l.direction = 'outbound')::text AS sent
               FROM addresses a
               JOIN domains d ON d.id = a.domain_id
               LEFT JOIN mail_log l ON l.address_id = a.id
                    AND l.created_at > now() - interval '30 days'
              WHERE d.user_id = $1
              GROUP BY a.id, d.name, a.local_part
              ORDER BY count(l.id) FILTER (WHERE l.direction = 'outbound') DESC, email
              LIMIT 5`,
      values: [userId],
    })

    const totals = await db().one<{ sent: string; received: string }>({
      text: `SELECT count(*) FILTER (WHERE direction = 'outbound')::text AS sent,
                    count(*) FILTER (WHERE direction = 'inbound')::text AS received
               FROM mail_log
              WHERE user_id = $1 AND created_at > now() - interval '30 days'`,
      values: [userId],
    })

    const pendingDomains = await db().all<{ id: string; name: string }>({
      text: "SELECT id, name FROM domains WHERE user_id = $1 AND status <> 'active' ORDER BY name",
      values: [userId],
    })

    return json(c, 200, {
      object: "overview",
      activity: {
        sent: Number(totals?.sent ?? 0),
        received: Number(totals?.received ?? 0),
        days: Object.entries(days).map(([day, counts]) => ({ day, ...counts })),
      },
      usage: {
        bytes_used: usage.bytesUsed,
        storage_bytes: usage.storageBytes,
        used_label: formatBytes(usage.bytesUsed),
        limit_label: formatBytes(usage.storageBytes),
        percent:
          usage.storageBytes > 0
            ? Math.min(100, Math.round((usage.bytesUsed / usage.storageBytes) * 100))
            : 0,
      },
      top_senders: topSenders.map((r) => ({ email: r.email, sent: Number(r.sent) })),
      entitlement: entitlementObject(entitlementFrom(c), usage),
      // Surfaced on the Overview because an unverified domain is the single
      // most common reason mail is not arriving, and it is invisible otherwise.
      pending_domains: pendingDomains,
      mail_hosts: {
        imap: { host: config.mail.imap, port: 993, security: "SSL/TLS" },
        pop3: { host: config.mail.pop, port: 995, security: "SSL/TLS" },
        smtp_implicit: { host: config.mail.smtp, port: 465, security: "SSL/TLS" },
        smtp_explicit: { host: config.mail.smtp, port: 587, security: "STARTTLS" },
      },
    })
  }),

  /**
   * Client Configuration — the same values, on their own for the settings tab.
   *
   * These are read by a person who then types them into a mail client, so a
   * port listed here that does not work is the same failure as autoconfig
   * naming one: the account is created and every send fails. The STARTTLS row
   * appears only when the server can actually perform the upgrade, and the
   * ports come from configuration rather than being assumed — an install on
   * non-standard ports would otherwise be told to use the standard ones.
   */
  getR("/api/client-config", { before: authedWithPlan, assigns: {} as never }, async (c) =>
    json(c, 200, {
      object: "client_config",
      servers: [
        {
          protocol: "Incoming Server (IMAP)",
          host: config.mail.imap,
          port: config.imap.tlsPort,
          security: "SSL/TLS",
        },
        {
          protocol: "Incoming Server (POP3)",
          host: config.mail.pop,
          port: config.pop3.tlsPort,
          security: "SSL/TLS",
        },
        {
          protocol: "Outgoing Server (SMTP)",
          host: config.mail.smtp,
          port: config.smtp.submissionTlsPort,
          security: "SSL/TLS",
        },
        ...(startTlsOffered()
          ? [
              {
                protocol: "Outgoing Server (SMTP)",
                host: config.mail.smtp,
                port: config.smtp.submissionPort,
                security: "STARTTLS",
              },
            ]
          : []),
      ],
      username_hint: "Your full email address",
      password_hint:
        "Your account password if this mailbox is your own; otherwise the mailbox's own password.",
      webmail_url: `${config.publicUrl}/webmail`,
    }),
  ),
]
