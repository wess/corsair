---
title: Monitoring
description: What to watch, what to alert on, and the queries that tell you whether mail is actually flowing.
section: operate
order: 7
eyebrow: Install and operate
---

# Monitoring

Mail fails quietly. A queue that stops draining, a certificate that expired, a
disk that filled — none of them announce themselves, and all of them look like
"my email is a bit slow today" until someone notices a week of missing messages.

These are the things worth watching, in the order they matter.

## Alert on these

| Signal | Threshold | Why |
| --- | --- | --- |
| Process not running | Any | Nothing else matters |
| Queue depth climbing | Growing for 30 min | Delivery is stuck |
| Oldest queued message | Older than 1 hour | Something is failing repeatedly |
| Certificate expiry | Under 14 days | Renewal or the reload hook broke |
| Disk free | Under 20% | Postgres stops writing when it fills |
| Bounce rate | Over 5% of sends | Reputation damage in progress |
| Webhook endpoints disabled | Any | Twenty consecutive failures disabled one |
| Backup heartbeat | Missing for 36 hours | The backup silently stopped |

## Is it running

```sh
systemctl is-active corsair
curl -sf localhost:3000/api/plans >/dev/null && echo ok
```

`/api/plans` needs no authentication and touches the database, so a 200 means the
HTTP tier is up *and* Postgres is reachable. That makes it a reasonable liveness
check.

For the mail listeners, check the sockets:

```sh
for p in 25 587 465 143 993 110 995; do
  nc -z localhost $p && echo "$p ok" || echo "$p DOWN"
done
```

## The delivery queue

The single most useful thing to watch. If it drains, mail is flowing.

```sql
SELECT status, count(*), min(created_at) AS oldest
FROM deliveries
GROUP BY status;
```

Depth alone is not the alarm — a spike after a burst of sending is normal. What
matters is **depth that keeps growing** and **an oldest entry that keeps getting
older**.

Failures back off from one minute out to about five days, so a genuinely
undeliverable message sits in the queue for days by design. A pile of them
appearing at once usually means one destination is refusing you.

```sql
-- What is failing, and where to. last_error is the verbatim final SMTP reply,
-- which is what distinguishes a greylist from a block.
SELECT split_part(rcpt_to, '@', 2) AS domain,
       count(*),
       max(last_code) AS code,
       max(last_error) AS reply
FROM deliveries
WHERE attempts > 2 AND status <> 'sent'
GROUP BY 1
ORDER BY 2 DESC
LIMIT 10;
```

One domain dominating that list is a reputation problem with that provider. Every
domain appearing means your outbound path is broken.

## Inbound flow

```sql
SELECT date_trunc('hour', created_at) AS hour, count(*)
FROM mail_log
WHERE direction = 'inbound' AND created_at > now() - interval '24 hours'
GROUP BY 1 ORDER BY 1;
```

An hour with zero inbound on a domain that normally receives is worth
investigating. It is usually DNS or a firewall, not the application.

## Storage

```sql
-- Per account. Tombstoned rows still occupy the folder until the retention
-- sweep clears them, so exclude them or the numbers read high.
SELECT u.email, pg_size_pretty(sum(m.size)::bigint) AS used
FROM messages m
JOIN addresses a ON a.id = m.address_id
JOIN domains d ON d.id = a.domain_id
JOIN users u ON u.id = d.user_id
WHERE m.expunged_at IS NULL
GROUP BY 1 ORDER BY sum(m.size) DESC
LIMIT 20;
```

Corsair emits `quota.warning` and `quota.exceeded` webhooks; subscribing to those
is easier than polling.

Host disk matters separately:

```sh
df -h /var/lib/postgresql
```

Postgres stops accepting writes when the filesystem fills, and a mail server that
cannot write is a mail server that rejects. Alert well before it happens.

## Certificate expiry

```sh
openssl s_client -connect mail.example.com:993 -servername mail.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -enddate
```

Check the port, not the file. The file on disk being fresh proves nothing if the
process is still holding the old one — which is exactly the failure mode of
renewal without a reload hook.

```sh
# Days remaining, for a monitoring check
expiry=$(openssl s_client -connect mail.example.com:993 </dev/null 2>/dev/null \
  | openssl x509 -noout -enddate | cut -d= -f2)
echo $(( ($(date -d "$expiry" +%s) - $(date +%s)) / 86400 ))
```

## Webhook health

```sql
SELECT url, status, consecutive_failures, last_success_at
FROM webhooks
WHERE status <> 'active' OR consecutive_failures > 0;
```

An endpoint that fails twenty times in a row is disabled automatically. Nothing
tells you except the panel, so query for it.

## Bounce rate

```sql
-- mail_log.status is one of accepted, rejected, delivered, deferred, bounced, spam
SELECT
  count(*) FILTER (WHERE status = 'bounced')::float
    / NULLIF(count(*), 0) AS bounce_rate
FROM mail_log
WHERE direction = 'outbound' AND created_at > now() - interval '24 hours';
```

Above a few percent and receivers start treating you as a source of junk.
Corsair suppresses nothing automatically, but it records every bounce —
repeatedly delivering to an address that hard-bounces is one of the fastest ways
to damage a sending reputation.

## Logs

```sh
journalctl -u corsair -f
journalctl -u corsair --since "1 hour ago" | grep -i error
docker compose logs -f corsair        # if containerised
```

Worth grepping for:

| Pattern | Meaning |
| --- | --- |
| `unhandled route error` | An API bug. Should be rare; investigate each one |
| `job .* failed` | A worker job threw. It retries |
| `rejected` | Inbound refusals — no such user, over quota, filtered |

:::warning Mail logs contain addresses
Sender and recipient addresses are personal data. Decide your retention period
deliberately and configure `journald` or your log shipper to honour it.
:::

## The worker

Four periodic jobs, guarded by a Postgres advisory lock so several workers do not
all start the same sweep:

| Job | Does |
| --- | --- |
| `domain.verify` | Re-checks pending domains, every half hour |
| `transfer.run` | Runs mailbox migrations |
| `quota.recompute` | Recalculates account storage |
| `retention.sweep` | Expires tombstones, logs, bans, and sessions |

```sql
SELECT kind, status, count(*), max(updated_at)
FROM jobs GROUP BY 1, 2;
```

Jobs stuck in `running` with an old `updated_at` mean a worker died mid-job.

## External checks

Things a check on the host cannot see:

- **Deliverability.** Send to a seed address at a large provider on a schedule and
  assert `dkim=pass`. This catches an expired DKIM record, which nothing local
  will.
- **Blocklists.** Query your IP against Spamhaus and SpamCop daily. Being listed
  is silent until mail starts bouncing.
- **Inbound reachability.** Connect to port 25 from outside. A firewall rule that
  changed is invisible from inside.
- **DNS.** Assert the MX, SPF, DKIM, and DMARC records still resolve. Someone
  editing DNS for an unrelated reason is a common cause of sudden failure.

## A minimal setup

If you do only four things:

1. Alert when the process is down.
2. Alert when the oldest queued message is over an hour old.
3. Alert when the certificate has under fourteen days.
4. Alert when the backup heartbeat goes quiet.

Those four cover the failures that lose mail. Everything else on this page is
refinement.
