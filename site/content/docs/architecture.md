---
title: Architecture
---

# Architecture

One Bun process, PostgreSQL, and an S3-compatible bucket.

```
                    ┌──────────────┐
   port 25 ────────►│  SMTP  (MX)  │──┐
   587 / 465 ──────►│  submission  │  │
                    └──────────────┘  │
                                      ▼
   993 / 143 ──────►┌──────────────┐  ┌──────────┐   ┌────────────┐
   995 / 110 ──────►│  IMAP / POP3 │◄─┤ Postgres │   │   bucket   │
                    └──────────────┘  │ metadata │   │   bodies   │
                                      └──────────┘   └────────────┘
   3000 ───────────►┌──────────────┐        ▲               ▲
                    │ API + panel  │────────┤               │
                    │ webmail      │        │               │
                    │ JMAP         │────────┘               │
                    └──────────────┘                        │
                    ┌──────────────┐                        │
                    │    worker    │────────────────────────┘
                    └──────────────┘
```

## The split between Postgres and the bucket

Message **metadata** — folder, UID, flags, envelope, size, a searchable text
extract — lives in Postgres. Message **bodies** live in the bucket.

That split is what makes IMAP fast. `SELECT`, `FETCH FLAGS`, `SEARCH`, and
`SORT` are the commands a client runs constantly, and none of them need the
body. Only `FETCH BODY[...]` does, and then exactly one object is read.

Without a bucket configured, bodies stay inline in Postgres. That works and
keeps a single-container install to one dependency, but it puts mail volume
through the WAL.

## Receiving

A message arriving on port 25 is checked for SPF, verified for DKIM, evaluated
against the From domain's DMARC policy, and scored. The results are stamped into
an `Authentication-Results` header so a client can see them.

Then each recipient is resolved: an exact address, then sub-addressing
(`user+tag@` → `user@`), then the domain's catch-all, then its fallback domain
followed once. A mailbox recipient runs its Sieve filter and is written to a
folder; a forwarding recipient is queued for outbound delivery with an
SRS-rewritten sender.

## Sending

Submission proves the caller owns the From address, checks the daily limit,
completes any headers the client left off, signs with the domain's DKIM key,
files a copy in Sent, and queues one row per recipient.

The queue claims work with `FOR UPDATE SKIP LOCKED`, so any number of workers
can drain it without coordinating and without delivering anything twice.
Failures back off from one minute out to about five days.

## Reading

Four protocols read the same rows: IMAP, JMAP, POP3, and the webmail API. There
is no per-protocol copy and no synchronisation step between them, which is why a
message that arrives over SMTP is visible in all four immediately.

JMAP is the modern one — a single HTTPS endpoint taking batched method calls,
with back-references so a client can query and fetch in one round trip, and
state strings so it can ask what changed rather than re-walking a mailbox. The
session resource is at `/.well-known/jmap`.

The IMAP server keeps a per-session snapshot of the folder in UID order —
which is what sequence numbers index into — and reconciles it against the
database at each command boundary, emitting `EXPUNGE` highest-first so a client
renumbers correctly.

UIDs are allocated with `UPDATE folders SET uid_next = uid_next + 1 ...
RETURNING`, which takes a row lock. Two simultaneous deliveries cannot be handed
the same UID, and a duplicate UID is the one thing an IMAP client never recovers
from.

## The worker

Re-checks pending domains every half hour, drains the delivery queue, runs
mailbox transfers, recomputes quota, and sweeps expired tombstones, logs, bans,
and sessions. Periodic work is guarded by a Postgres advisory lock so several
workers do not all start the same sweep.
