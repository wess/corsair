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

## DANE

DANE (RFC 7672) is the other way a domain says "never send me mail in the clear".
Instead of a policy fetched over HTTPS, it publishes TLSA records next to its MX
host in a DNSSEC-signed zone, and the records pin the MX's certificate or key.
When those records are authenticated, a sender must use STARTTLS and the
certificate must match one of them — or it does not deliver.

### Sending to DANE domains

With `DELIVERY_TRANSPORT=direct`, Corsair looks up the MX and TLSA records through
a **validating resolver** and reads the DNSSEC result from the AD bit of each
reply. Node's resolver does not expose that bit, so these lookups use a small DNS
client of Corsair's own, asking `DANE_RESOLVER`.

| What DNS says | What Corsair does |
| --- | --- |
| MX not signed | No DANE. Ordinary opportunistic STARTTLS |
| MX signed, MX host's address not signed | No DANE for that host |
| TLSA signed, with usable records | STARTTLS required; certificate must match |
| TLSA signed, but no usable records | STARTTLS required; certificate not checked |
| TLSA signed "does not exist", or not signed | No DANE. Opportunistic STARTTLS |
| TLSA lookup fails (SERVFAIL, timeout) | That host is deferred; the next MX is tried |

A failed match, a missing STARTTLS, or a broken DNSSEC answer is a **deferral**
(`4.7.5`), never a bounce and never a fallback to plaintext. The queue retries
it like any other temporary failure, and the reason is in the delivery log.

Usages `3` (DANE-EE) and `2` (DANE-TA) are supported, with selectors `0` and `1`
and matching types `0`, `1`, and `2`. A DANE-EE record pins the certificate
alone: name and expiry are not checked, which is what the RFC asks for. A DANE-TA
record pins an issuer; the chain up to it must verify, every certificate on it
must be current, and the certificate must name the MX host, its CNAME target, or
the recipient domain. Usages `0` and `1` are ignored, as RFC 7672 requires for
SMTP. When a domain has both DANE and MTA-STS, DANE wins.

:::warning The resolver is the trust anchor
Corsair does not validate signatures itself. It believes the resolver's AD bit,
and anyone between Corsair and the resolver can set that bit on a forged reply.
Run a validating resolver **on the same machine** — unbound listening on
`127.0.0.1` is the usual choice — and point `DANE_RESOLVER` at it. A resolver
that is not on loopback is refused unless you set
`DANE_TRUST_REMOTE_RESOLVER=true`, which you should only do for a resolver on a
network path you control.
:::

```sh
apt install unbound          # validates DNSSEC out of the box
echo 'DANE_RESOLVER=127.0.0.1' >> .env
```

At startup Corsair asks the resolver for the root zone (which must come back with
AD set) and for `dnssec-failed.org` (which must not come back at all, because its
signatures are deliberately broken). Passing both is what `DANE=auto` means by "a
validating resolver". The log says which way it went:

```text
[corsair] dane        on — resolver 127.0.0.1:53 validates DNSSEC
[corsair] dane        off — resolver 192.168.1.1:53 is not on loopback; ...
```

`DANE=on` skips the probe but not the loopback rule. `DANE=off` disables it.

### Publishing TLSA for your own MX

DANE for mail *arriving* here is DNS you publish; Corsair has nothing to switch
on. It needs a DNSSEC-signed zone for the MX host's name and STARTTLS on port 25
(see [TLS](tls.html)). Then publish a `3 1 1` record — the SHA-256 of the
certificate's public key — at `_25._tcp.` plus the MX hostname:

```sh
openssl x509 -in /etc/corsair/certs/fullchain.pem -noout -pubkey \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -binary | xxd -p -c 64
```

```text
_25._tcp.mx1.example.com. 3600 IN TLSA 3 1 1 <that hex>
```

`3 1 1` pins the key, not the certificate, so a renewal that keeps the key needs
no DNS change. That is the reason to prefer it over `3 0 1`.

:::danger Key changes take the MX off the air for DANE senders
A sender that sees a TLSA record and a key that does not match it does not
deliver — it defers, and keeps deferring. Certbot generates a **new key on every
renewal** unless told not to, so a renewal can silently stop mail from every
DANE-checking sender (including the large mailbox providers).

Renew with `--reuse-key`. When you do have to change the key:

1. Generate the new key and publish its `3 1 1` record **alongside** the current
   one. Both records live in the RRset at once.
2. Wait at least two TTLs of the TLSA record so every cache holds both.
3. Switch the certificate to the new key.
4. Remove the old record.
:::

Check the result from outside with `dig +dnssec TLSA _25._tcp.mx1.example.com`
(the `ad` flag must be set when asked through a validating resolver) and with any
public DANE SMTP checker.

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
