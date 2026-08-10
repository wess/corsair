---
title: Scaling and performance
description: Where the limits actually are, what to measure, and what to do when one of them is reached.
section: operate
order: 9
short: Scaling
eyebrow: Install and operate
---

# Scaling and performance

Corsair is one process against one database. That takes you further than people
expect, and the things that break first are rarely the ones people plan for.

## Where the limits are

| Limit | Reached at roughly | What happens |
| --- | --- | --- |
| Postgres connections | `DB_POOL_SIZE` concurrent queries | Requests queue |
| Worker throughput | `WORKER_CONCURRENCY` deliveries at once | The queue grows |
| Disk, without a bucket | Mail volume through the WAL | Writes slow, then stop |
| IMAP sessions | Memory, one snapshot per selected folder | RSS climbs |
| Receiver rate limits | Their policy, not yours | Deferrals |

The last one is the real ceiling for outbound volume, and no amount of hardware
moves it.

## Sizing

| Mailboxes | vCPU | RAM | Disk (metadata only) |
| --- | --- | --- | --- |
| 1–10 | 1 | 1 GB | 10 GB |
| 10–100 | 2 | 2 GB | 25 GB |
| 100–1000 | 4 | 8 GB | 100 GB |

With `STORAGE_BUCKET` set, bodies are in object storage and the disk figure is
metadata only — a few kilobytes per message. Without a bucket, add the full size
of every message you keep, and expect the WAL to carry all of it.

## Configure the bucket

The single highest-value change for anything beyond a personal server.

```sh
STORAGE_BUCKET=my-mail-bucket
STORAGE_ENDPOINT=https://nyc3.digitaloceanspaces.com
STORAGE_REGION=nyc3
STORAGE_ACCESS_KEY_ID=...
STORAGE_SECRET_ACCESS_KEY=...
```

Metadata — folder, UID, flags, envelope, size, a searchable text extract — stays
in Postgres. Bodies go to the bucket.

That split is what makes IMAP fast. `SELECT`, `FETCH FLAGS`, `SEARCH`, and `SORT`
are what a client runs constantly, and none of them need a body. Only
`FETCH BODY[…]` does, and then exactly one object is read.

It also takes mail volume out of the WAL, which is what actually kills a busy
inline install.

## The database

**Raise the pool** before anything else. The default of 10 is conservative:

```sh
DB_POOL_SIZE=25
```

Keep `DB_POOL_SIZE` × instances comfortably under Postgres's `max_connections`.
Above a few dozen, put PgBouncer in transaction mode between them.

**Watch for slow queries.**

```sql
SELECT calls, mean_exec_time, left(query, 90)
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 10;
```

**Autovacuum matters here.** `messages` churns — flags update on every read, rows
are tombstoned on expunge. Bloat shows up as IMAP getting slower for no visible
reason.

```sql
SELECT relname, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 10000
ORDER BY n_dead_tup DESC;
```

For a busy `messages` table, make autovacuum more aggressive on it specifically:

```sql
ALTER TABLE messages SET (autovacuum_vacuum_scale_factor = 0.05);
```

## The worker

```sh
WORKER_CONCURRENCY=16
WORKER_POLL_MS=500
```

Raise concurrency before adding processes. The queue claims work with
`FOR UPDATE SKIP LOCKED`, so any number of workers can drain it without
coordinating and without delivering anything twice — but each one is another set
of database connections.

Lower `WORKER_POLL_MS` only if queue latency matters to you; it is a poll against
Postgres, and 100 ms costs ten times what 1000 ms costs for a benefit nobody
perceives in email.

:::warning Concurrency does not beat a receiver's rate limit
Sixteen parallel connections to one provider gets you `421 4.7.0` faster than one
does. The limits that matter for bulk outbound are theirs.
:::

## Splitting the tiers

```sh
bun src/server.ts                                    # HTTP only
SMTP_ENABLED=true IMAP_ENABLED=false bun src/start.ts # mail only
```

Worth doing when:

- **Deploys are disrupting mail clients.** Restart HTTP without dropping IMAP.
- **One tier needs different hardware.** HTTP behind a load balancer; the mail
  listeners on the host that owns the reputable IP.
- **The worker needs its own capacity.** Run several; they cannot double-deliver.

## Running more than one mail host

Publish two MX records at equal priority, both pointing at Corsair instances
sharing one database.

```
example.com.  MX  10  mx1.example.com.
example.com.  MX  10  mx2.example.com.
```

Senders pick one and retry the other on failure. Inbound distributes itself, and
you can restart one at a time without losing anything.

Two things to get right:

- **Every host needs its own PTR** matching its own `CORSAIR_HOSTNAME`.
- **SPF must list both.** They send as well as receive.

The database stays single-writer. That is the actual scaling ceiling, and it is a
long way up.

## Measuring

Before optimising, find out which resource is the constraint.

```sh
# Is it the database?
psql "$DATABASE_URL" -c "SELECT count(*), state FROM pg_stat_activity GROUP BY state"

# Is it the queue?
psql "$DATABASE_URL" -c "SELECT status, count(*) FROM deliveries GROUP BY status"

# Is it the host?
top -b -n1 | head -15
iostat -x 1 3
```

A growing queue with an idle CPU is not a capacity problem — it is a receiver
deferring you, and the fix is reputation, not hardware.

## What is genuinely expensive

**IMAP SEARCH without an index hit.** A client searching a hundred-thousand-message
folder for a body substring reads bodies. `search_text` is maintained alongside
each row precisely so the common cases do not.

**FETCH of large messages.** One object per message, so a client downloading a
whole mailbox is bounded by the bucket's throughput, not by Corsair.

**Sub-addressing and catch-all resolution** run per recipient on the inbound path,
but they are indexed lookups. This has never been the bottleneck.

**The spam scorer** reads the raw message once. It is heuristic and cheap by
construction — deliberately, since it runs on every inbound message.

## Retention

The worker sweeps expired tombstones, logs, bans, and sessions. If `mail_log` is
growing without bound and you do not need the history, prune it — it is what the
Overview charts and the daily limits are counted from, so keep at least a few
days.

```sql
DELETE FROM mail_log WHERE created_at < now() - interval '90 days';
```

Do it in batches on a large table, or the lock is noticeable.

## When you have outgrown this

Corsair is one Postgres away from being a much bigger system, and the honest
answer is that at genuinely large scale you want software designed for shards
from the start. The point at which that becomes true is far past where most
people self-hosting mail will ever get — thousands of mailboxes on one machine is
comfortable.
