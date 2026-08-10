---
title: SMTP
description: The MX listener, authenticated submission, the inbound pipeline, and how outbound delivery retries.
section: reference
order: 3
eyebrow: Reference
---

# SMTP

Three listeners, two jobs. Port 25 receives mail from the internet; 587 and 465
accept mail from your own users.

| Port | Role | TLS | Authentication |
| --- | --- | --- | --- |
| 25 | MX — inbound from anywhere | STARTTLS, opportunistic | None |
| 587 | Submission | STARTTLS, required before AUTH | Address credential |
| 465 | Submission | Implicit from the first byte | Address credential |

Port 25 never requires STARTTLS. A sending server that does not support it still
has legitimate mail to deliver, and refusing means losing that mail. Every other
port requires encryption before a credential crosses it.

## Extensions advertised

```
250-mail.example.com at your service
250-SIZE 52428800
250-8BITMIME
250-SMTPUTF8
250-PIPELINING
250-ENHANCEDSTATUSCODES
250-STARTTLS
250-AUTH PLAIN LOGIN
250 HELP
```

`STARTTLS` appears only on a connection that is not already encrypted, and
**`AUTH` only on one that is**. On a server with no certificate configured, AUTH
is never advertised at all — which is the correct failure. A self-hoster who has
not set up TLS should discover it there rather than after their users' passwords
have crossed the network.

`CHUNKING` is deliberately not advertised. It invites `BDAT`, and a sender that
switches to BDAT against a server without it gets a hard failure rather than
falling back to `DATA`.

`SIZE` is `MAX_MESSAGE_BYTES`, 50 MB by default. That is the wire size after
encoding — base64 costs about a third, so it is roughly a 35 MB attachment.

## The inbound pipeline

A message arriving on port 25 goes through this, in order:

1. **Connection checks** — the client IP against the ban list and rate limits.
2. **SPF** — evaluated against the envelope sender.
3. **Recipient resolution** — per `RCPT TO`. An unknown recipient is refused
   **during the transaction** with a 550.
4. **DATA** — the message is read, bounded by `SIZE`.
5. **DKIM verification** — every signature on the message.
6. **DMARC** — the From domain's policy, applied to the SPF and DKIM results.
7. **Spam scoring** — heuristic, over the raw message plus the authentication
   signals.
8. **`Authentication-Results`** — stamped into the message so a client can see
   what the server made of it.
9. **Sieve** — the recipient's filter runs.
10. **Filing** — into a folder, with an atomically allocated UID.
11. **Events** — `message.received`, `message.spam`, or `message.rejected`.

:::note Rejection happens during the transaction, not afterwards
An unknown recipient gets a 550 at `RCPT TO`. Corsair does not accept and then
bounce — a bounce to a forged sender is backscatter, and it makes you a source of
spam for someone else. Refusing during the transaction puts the problem back on
the sending server, which is where it belongs.
:::

### Recipient resolution

For each `RCPT TO` at a hosted domain, in order:

1. An exact address match
2. Sub-addressing — `user+tag@` routes to `user@`
3. The domain's catch-all
4. The domain's fallback domain, followed **exactly once**

A mailbox recipient runs its Sieve filter and is written to a folder. A forwarding
recipient — an alias or a group — is queued for outbound delivery with an
SRS-rewritten sender.

### Spam scoring

Heuristic, deliberately conservative, and cheap by construction because it runs on
every inbound message.

A message scoring at or above the junk threshold is **filed in `Junk`**, not
rejected. Rejecting on a heuristic score loses real mail silently, which is a
much worse failure than a message in the wrong folder.

The score is recorded on the message row and in `mail_log`, and goes out on the
`message.spam` webhook.

## Submission

Authenticated sending, on 587 and 465.

1. **Authenticate.** `PLAIN` or `LOGIN`, only over an encrypted connection.
2. **Prove the sender.** The From address must belong to the authenticated
   address. This is the difference between a mail server and an open relay.
3. **Check the daily limit** from the plan.
4. **Complete the headers** the client left off — `Date`, `Message-ID`, `MIME-Version`.
5. **Sign** with the domain's active DKIM key.
6. **File a copy** in `Sent`.
7. **Queue** one row per recipient.

Header values are sanitised on the way out. A bare CR or LF in a subject, a
display name, or a custom header injects a header, so `stripControls` runs on
every value this codebase emits. There are regression tests for it.

## Outbound delivery

Queued in the `deliveries` table, drained by the worker.

| Transport | Behaviour |
| --- | --- |
| `direct` | Resolve the recipient's MX and deliver. Needs port 25 outbound |
| `relay` | Hand everything to a configured smarthost |
| `console` | Print to stdout. The default, for local development |

The queue claims work with `FOR UPDATE SKIP LOCKED`, so any number of workers can
drain it without coordinating and without delivering anything twice.

### Retries

Failures back off from about one minute out to roughly **five days**, after which
the message bounces. The final SMTP reply is stored **verbatim** — operators need
the original text, not a paraphrase, to tell a greylist from a block.

```sql
SELECT rcpt_to, status, attempts, last_code, last_error, run_at
FROM deliveries
WHERE status <> 'sent'
ORDER BY updated_at DESC;
```

A `4xx` is temporary and retried. A `5xx` is permanent and bounces immediately —
there is no point retrying a refusal.

### SRS

An alias that forwards keeps the original envelope sender, whose SPF does not
list your server. The next hop sees a forgery and rejects it.

Corsair rewrites the envelope sender with SRS so it survives. The HMAC in the
rewritten address is not optional — without it, the rewritten address is an open
relay for anyone who can construct one.

This is automatic for aliases and groups.

## Bounces

A permanent failure generates a bounce to the original sender and fires
`message.bounced`. Bounces are recorded in the `bounces` table.

Corsair suppresses nothing automatically. Repeatedly delivering to an address that
hard-bounces is one of the fastest ways to damage a sending reputation — build a
suppression list from the webhook if you send at volume.

## Testing by hand

Inbound:

```sh
nc mail.example.com 25
```

```
EHLO test.example.net
MAIL FROM:<someone@test.example.net>
RCPT TO:<you@example.com>
DATA
From: Someone <someone@test.example.net>
To: you@example.com
Subject: Test

Body text.
.
QUIT
```

Submission, which needs TLS first:

```sh
openssl s_client -starttls smtp -connect mail.example.com:587 -crlf
```

```
EHLO test
AUTH PLAIN <base64 of \0user@example.com\0password>
MAIL FROM:<you@example.com>
RCPT TO:<someone@elsewhere.com>
DATA
...
.
QUIT
```

## Reply codes

Corsair uses enhanced status codes throughout. `250 2.1.5 Recipient OK`, `550
5.1.1 No such user`, and so on.

[SMTP error lookup](smtp-errors.html) has the full table, including the codes you
will see coming back from other people's servers.

## Everything on the wire is latin1

The SMTP session, the MIME parser, and the storage layer handle messages as
latin1 strings, so one character is exactly one byte.

`SIZE` and `RFC822.SIZE` are octet counts. Decoding to UTF-8 anywhere in that path
silently changes every offset. Decoding to real Unicode happens only at the point
something displays text.
