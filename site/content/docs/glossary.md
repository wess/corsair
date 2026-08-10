---
title: Glossary
description: The mail vocabulary this manual assumes, defined once.
section: reference
order: 10
eyebrow: Reference
---

# Glossary

Terms this manual uses without explaining them again.

## Addressing

**Address** — In Corsair, a mailbox credential or a routing entry, of one of four
kinds: `standard`, `catchall`, `alias`, or `group`. Distinct from a **user**.

**Alias** — An address with no mailbox and no password that forwards to exactly
one destination.

**Catch-all** — A mailbox that also receives anything in the domain matching
nothing else. One per domain.

**Group** — An address with no mailbox that fans out to several destinations.

**Local part** — The bit before the `@`.

**Sub-addressing** — `you+tag@example.com` routing to `you@example.com`. Also
called plus-addressing. Works with no configuration.

**User** — A control-panel login that owns domains. Never a mailbox credential.

## Authentication

**DKIM** — DomainKeys Identified Mail. A cryptographic signature over the message,
verified against a public key in DNS. Survives forwarding.

**DMARC** — Tells receivers what to do when a message claiming to be from your
domain passes neither an aligned SPF nor an aligned DKIM check. Passes if
**either** does.

**Alignment** — Whether the domain that passed SPF or DKIM matches the domain in
the `From:` header. An unaligned pass does not satisfy DMARC.

**Selector** — Names one DKIM key, so several can coexist. Corsair creates three
per domain; the receiver reads which was used from the signature's `s=`.

**SPF** — Sender Policy Framework. A DNS record listing which servers may send as
your domain. Broken by forwarding.

**SRS** — Sender Rewriting Scheme. Rewrites the envelope sender on forwarded mail
so it passes the next hop's SPF check. Corsair does this automatically; the HMAC
in the rewritten address is what stops it being an open relay.

## Delivery

**Backscatter** — A bounce sent to a forged sender. Accepting mail and bouncing it
later makes you a source of spam for whoever was forged. Corsair rejects during
the SMTP transaction instead.

**Bounce** — A permanent delivery failure returned to the sender.

**Deferral** — A temporary failure (`4xx`). The sender retries.

**Envelope** — The `MAIL FROM` and `RCPT TO` of the SMTP transaction, as opposed
to the `From:` and `To:` headers. They need not match, and filters should usually
match on the envelope.

**Greylisting** — Temporarily refusing a first delivery attempt from an unknown
sender, on the theory that spam software does not retry. Normal; needs no action.

**MX** — The DNS record naming where a domain's mail is delivered.

**PTR** — The reverse DNS record mapping an IP back to a hostname. Must match
`CORSAIR_HOSTNAME`, or large providers reject on connect.

**Relay / smarthost** — An upstream server you hand outbound mail to instead of
delivering it yourself. The answer when port 25 is blocked.

**Submission** — Authenticated sending by your own users, on 587 or 465. Distinct
from the MX role on port 25.

## Protocols

**IMAP** — The protocol clients use to read mail that stays on the server. Folders,
flags, and multiple devices.

**JMAP** — A modern JSON-over-HTTP alternative to IMAP, with batched calls and
incremental sync.

**POP3** — Downloads and usually deletes. No folders, no shared state.

**SMTP** — The protocol that moves mail between servers, and that clients use to
send.

**STARTTLS** — Upgrading a plaintext connection to TLS mid-session. Distinct from
implicit TLS, which is encrypted from the first byte.

**MTA-STS** — A policy telling senders to require TLS when delivering to you.

## Storage

**Flag** — Per-message state: `\Seen`, `\Answered`, `\Flagged`, `\Deleted`,
`\Draft`, plus any keyword a client sets.

**Expunge** — Permanently removing messages marked `\Deleted`. Emitted
highest-sequence-first, because IMAP renumbers after every one.

**Modseq** — A monotonically increasing number per change, used for incremental
sync.

**Sequence number** — A message's position in the folder, which **renumbers** when
anything is expunged. Not stable; use a UID.

**Special use** — An attribute marking a folder's role (`\Sent`, `\Junk`) so
clients file things correctly without configuration.

**UID** — A message's permanent identifier within a folder. Never reused, never
changed. A duplicate UID is the one thing an IMAP client never recovers from.

**UIDVALIDITY** — A folder generation number. If it changes, a client throws away
its cache and starts over.

## Corsair specifics

**Entitlement** — An account's plan plus its live subscription. Determines
storage, daily limits, and which features are available.

**Fallback domain** — A domain that unmatched recipients are sent on to, followed
exactly once.

**Instance owner** — The first user created. `users.is_owner`, guarded by a
partial unique index.

**Plate** — Not a Corsair term. It is the bordered panel this documentation site
is built out of.

**Sieve** — The standard mail filtering language, RFC 5228. No loops, no
recursion, no network calls — which is why it is safe to run a user's script on
the delivery path.

**Tombstone** — A record that a message was expunged, kept until the retention
sweep so a client that was offline can be told what disappeared.

**Unmetered** — An instance with no plans configured. Every feature on, no caps.

## Reply codes

**2xx** — Success.

**4xx** — Temporary. The sender will retry, often for days.

**5xx** — Permanent. The message bounces.

**Enhanced status code** — The second, dotted code (`5.1.1`) carrying more detail
than the three-digit reply. See [SMTP error lookup](smtp-errors.html).
