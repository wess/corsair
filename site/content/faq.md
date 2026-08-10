---
title: FAQ
description: Common questions about running Corsair.
---

# Frequently asked questions

## Do I need port 25?

To deliver mail directly to recipients, yes — and most cloud providers block it
outbound by default. DigitalOcean and Hetzner unblock it on request;
AWS requires a form.

If you cannot get it unblocked, set `DELIVERY_TRANSPORT=relay` and point
`SMTP_RELAY_HOST` at a smarthost. Corsair still receives mail on 25 inbound
(which is never blocked) and still signs everything with DKIM; it just hands
outbound delivery to somebody with a clean IP.

## Will my mail land in spam?

That depends almost entirely on things outside the software:

- A **PTR record** on your sending IP that matches `CORSAIR_HOSTNAME`. Without
  it, the large providers reject on connect.
- **SPF, DKIM, and DMARC** published for every sending domain. Corsair generates
  all three and refuses to send from a domain that has not finished DNS setup —
  precisely so this cannot go wrong quietly.
- **A clean IP.** A fresh address from a cheap VPS range may already be listed.
  Check it against the common blocklists before you commit to it.

## Can I read mail in a browser?

Corsair ships its own webmail at `/webmail`. Sign in with the mailbox address
and its password — not your control-panel credentials, which are a separate
identity on purpose.

Message bodies are sanitised on the server before the browser sees them, and
remote images are withheld until you ask for them, because a remote image in an
email reports when you opened it and from where.

If you would rather run something else, the IMAP and JMAP servers are standard.
Roundcube and SnappyMail work against IMAP unchanged; any JMAP client can use
the session resource at `/.well-known/jmap`.

## Does it support JMAP?

Yes — RFC 8620 and RFC 8621. Session discovery, batched method calls with
back-references, `Mailbox`, `Email`, `Thread`, `Identity`, `EmailSubmission`,
and blob upload and download. Authenticate with Basic credentials using the
mailbox address and password.

Not implemented: `SearchSnippet`, `VacationResponse`, and push channels. They
are absent from the advertised capabilities rather than stubbed, so a client can
discover what is missing rather than failing at the call.

## What happens if the object store goes down?

Message metadata is in Postgres and stays queryable — folder lists, counts,
subjects, and search all keep working. Fetching a body returns nothing until the
bucket is back. Incoming mail still gets a row but its body write fails, so the
delivery is retried by the sender rather than silently lost.

## Does it support catch-all addresses?

One per domain. It receives anything that does not match a real address, after
sub-addressing has been tried. Be aware that a catch-all on a domain that has
ever leaked will collect a great deal of spam.

## What about aliases that forward off-server?

Supported, and SRS-rewritten. Forwarding without SRS is the most common reason
an alias "randomly stops working": the envelope sender still names the original
domain, whose SPF record does not list your server, so the next hop sees a
forgery. Corsair rewrites the sender into the forwarding domain and can still
route bounces home.

## Can two accounts host the same domain?

No. A domain is unique across the instance — two accounts claiming it would make
routing ambiguous.

## How do I back it up?

Two things: the Postgres database and the object bucket. `pg_dump` covers
everything except message bodies; the bucket covers the bodies. Restoring one
without the other leaves you with mailboxes whose messages have no content, or
objects nothing references.

## Is there an API?

The control panel talks to the same JSON API you can. It authenticates with a
session cookie, so anything the panel does is scriptable with `curl` after a
`POST /api/auth/login`.
