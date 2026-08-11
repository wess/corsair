---
title: Deliverability
description: Getting mail accepted is a reputation problem, not a software problem. What to do about it.
section: using
order: 8
eyebrow: Using Corsair
---

# Deliverability

Getting mail *accepted* is a different problem from sending it, and it is mostly
not a software problem. Corsair does its side correctly — SPF, DKIM, DMARC, SRS on
forwards, a matching PTR — and you still start from zero reputation and build up.

## The non-negotiables

**1. A PTR record** on the sending IP matching `CORSAIR_HOSTNAME`, with a forward
record that resolves back. Mismatched, and the large providers reject on connect
before seeing a message.

**2. SPF, DKIM, and DMARC** published for every sending domain. Corsair refuses to
send from a domain that has not finished DNS setup, precisely so this cannot go
wrong quietly.

**3. A clean IP.** Check it against the blocklists before committing. Cheap VPS
ranges are frequently listed before you ever boot the machine.

```sh
# 203.0.113.9 → reverse the octets
dig +short 9.113.0.203.zen.spamhaus.org
dig +short 9.113.0.203.bl.spamcop.net
```

An answer means listed. Most services have a self-service removal form; use it
before you start sending, not after.

## Warming up

A brand new IP sending a thousand messages on its first day looks exactly like a
compromised host, because that is what a compromised host does.

Start small. Keep the volume steady rather than spiky. Let it build over a couple
of weeks. Nothing about this is enforced by Corsair — it is how the receivers'
reputation systems work, and there is no way to opt out.

A rough shape, if you are moving real volume:

| Days | Messages per day |
| --- | --- |
| 1–3 | 50 |
| 4–7 | 200 |
| 8–14 | 1,000 |
| 15+ | Double weekly, watching deferrals |

If you are hosting mail for a household or a small team, none of this applies —
your volume is already in the noise.

## Reading the signals

| Reply | Means | Do |
| --- | --- | --- |
| `450 4.2.0` | Greylisting on a first attempt | Nothing. The retry is accepted |
| `421 4.7.0` | Rate limiting | Back off. Not a configuration error |
| `550 5.7.26` | No aligned SPF or DKIM | Fix DNS. Entirely fixable |
| `550 5.7.1` … PTR | Reverse DNS mismatch | Set the PTR at your host |
| `554` … listed | Blocklisted | Find the listing, request delisting |
| Sudden bulk rejection from one provider | Reputation | Usually follows a volume spike or a rising bounce rate |

Corsair records the verbatim final reply, which is what distinguishes a greylist
from a block:

```sql
SELECT rcpt_to, last_code, last_error, attempts
FROM deliveries WHERE status <> 'sent'
ORDER BY updated_at DESC LIMIT 20;
```

## Bounces

Corsair suppresses nothing automatically, but it records every bounce.

**Treat a `5xx` as permanent and stop.** Repeatedly delivering to an address that
hard-bounces is one of the fastest ways to damage a sending reputation — receivers
read it as a sender who does not maintain a list, which is a spammer's signature.

Build a suppression list from the `message.bounced`
[webhook](tutorials/webhook-consumer.html) if you send anything at volume.

`4xx` is temporary and Corsair retries with backoff out to about five days. That
is correct behaviour; do not shorten it.

## DMARC reports

Add `rua=` to your DMARC record before tightening the policy:

```
v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com
```

The aggregate reports tell you which senders are failing alignment — which is how
you discover the marketing platform, the ticketing system, or the CI server that
also sends as your domain and that you had forgotten about.

Move to `p=reject` only once those reports are clean. Going straight there means
silently killing a legitimate sender you did not know you had.

## MTA-STS

Corsair serves an MTA-STS policy at `/.well-known/mta-sts.txt`. Its mode tracks
what the MX can actually do:

| Mode | When | What a sender does |
| --- | --- | --- |
| `none` | STARTTLS is unavailable on this runtime | Nothing. The policy is published and deliberately not in effect |
| `testing` | STARTTLS works | Reports a TLS failure but still delivers |
| `enforce` | You set it, after watching the reports | Refuses to deliver without TLS |

:::warning Today this is `none`
Bun cannot upgrade an accepted socket to TLS, so port 25 does not offer
STARTTLS — see [TLS](./tls.html). An MTA-STS policy is a promise that it does,
and Corsair will not make a promise it cannot keep: every MTA-STS-aware sender
would attempt TLS, fail, and file a report against a policy nobody could safely
enforce.

Mail arriving on port 25 is therefore **unencrypted in transit**. Submission
(465), IMAP (993), and POP3 (995) are unaffected — they are encrypted from the
first byte.
:::

Once STARTTLS is available the mode becomes `testing` on its own. Change it to
`enforce` after you have watched the reports and are confident the MX list is
right.

:::danger Going straight to enforce
A wrong MX list under `enforce` silently blackholes your inbound mail — senders
refuse to deliver rather than falling back to plaintext, and you get no bounce
because they never connected.
:::

## Forwarding

Forwarding breaks SPF: the original sender's SPF does not list your server, so
the next hop sees a forgery.

Corsair rewrites the envelope sender with SRS, which fixes it. This is automatic
for aliases and groups and there is nothing to configure.

DKIM survives forwarding intact, which is why DMARC passing on **either** SPF or
DKIM is what makes forwarding workable at all.

## What damages reputation fastest

1. **Sending to addresses that hard-bounce**, repeatedly
2. **A volume spike** on a young IP
3. **Recipients marking you as spam** — which is mostly about whether they asked
   for the mail
4. **An open relay or a compromised account** sending through you
5. **Missing or mismatched PTR**, which is a permanent handicap rather than an
   event

## What barely matters

- The exact wording of your subject lines
- Whether you send HTML or plain text
- Unsubscribe links, unless you are sending bulk mail (in which case, do)
- The "spam score" of your message content, for ordinary correspondence

Reputation is about behaviour over time and authentication, not about avoiding
the word "free".

## If you cannot get good deliverability

Some situations do not have a fix:

- **A residential or dynamic IP.** On the Policy Block List by construction.
- **A cloud provider that will not open port 25.** Google Cloud and most Azure
  subscriptions.
- **A range with a bad history** you cannot get delisted.

In all three, run Corsair anyway and set `DELIVERY_TRANSPORT=relay` with a
smarthost that already has reputation. Inbound mail still arrives directly on
port 25; only outbound changes, and you keep every other property of hosting your
own mail.

That is a legitimate configuration, not a defeat.

## Checking your own work

Send to an address at a large provider and read the headers:

```
Authentication-Results: mx.google.com;
       spf=pass ...
       dkim=pass header.i=@example.com header.s=corsair-1
       dmarc=pass (p=QUARANTINE ...)
```

Three passes. Re-check this any time deliverability goes strange — it is the
fastest way to tell a configuration problem from a reputation one.
