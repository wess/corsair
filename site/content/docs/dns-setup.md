---
title: DNS setup
description: Every record Corsair asks for, what it does, what breaks without it, and how to check it.
section: operate
order: 3
short: DNS setup
eyebrow: Install and operate
---

# DNS setup

Ten records. Five are required; the rest make things work properly. This page
covers what each one does, what happens without it, and how to verify it.

| Record | Host | Purpose | Required |
| --- | --- | --- | --- |
| TXT | `@` | Ownership verification | Yes |
| TXT | `@` | SPF — which servers may send as you | Yes |
| TXT | `_dmarc` | DMARC — what to do when SPF and DKIM fail | Yes |
| CNAME | `corsair-1._domainkey` | DKIM signing key | Yes |
| CNAME | `corsair-2._domainkey` | Spare DKIM key, for rotation | No |
| CNAME | `corsair-3._domainkey` | Spare DKIM key, for rotation | No |
| CNAME | `mta-sts` | MTA-STS policy host | No |
| CNAME | `autoconfig` | Thunderbird automatic setup | No |
| CNAME | `autodiscover` | Outlook automatic setup | No |
| MX | `@` | Where your mail is delivered | Yes |

The panel generates all of them with the values for your installation, and marks
which are required. Only the first DKIM selector has to exist — a domain should
not sit unverified because someone added one CNAME.

This page explains them; it is not a substitute for the values on the DNS Setup
tab, which are the ones to publish.

## Verification

A TXT record containing a token unique to your domain.

It proves you control the domain before Corsair routes mail for it. Without that
check, anyone could add someone else's domain and start receiving their mail.

Keep it published. Removing it after verification means the domain fails its next
periodic re-check.

## SPF

```
v=spf1 include:spf.example-host.com -all
```

Lists which servers may send as your domain. `-all` means "and nobody else".

The `include:` value is whatever the operator set as `MAIL_SPF_HOST`. The check
is by prefix rather than exact match, so you can add other senders:

```
v=spf1 include:spf.example-host.com include:_spf.google.com -all
```

:::warning The ten-lookup limit
SPF allows ten DNS-querying mechanisms. Every `include:` counts, **and so does
every `include:` inside them** — a single `include:_spf.google.com` costs three or
four on its own.

Blowing the budget is a permanent error, and the effect is that SPF stops working
entirely rather than degrading. Check with an SPF flattening or validation tool
if you have more than three includes.
:::

**There must be exactly one `v=spf1` record.** Two is a permanent error. This
happens constantly when a domain is migrated and the old record is left behind.

`-all` versus `~all`: `-all` is a hard fail, `~all` a soft one. Start with `~all`
if you are unsure whether you have listed every sender, and tighten to `-all` once
you are.

## DKIM

Published as a **CNAME**, not a TXT record.

A 2048-bit key does not fit in a single TXT string, half the DNS control panels
in the world mangle the chunked form, and a CNAME lets the key rotate on the
server without you touching DNS again.

```
corsair-1._domainkey.example.com.  CNAME  dkim-1.mail.example.com.
```

Corsair answers the lookup at the target and serves the current public key.

Three selectors are created per domain. **Only the first has to exist**; the others
are there so a rotation is a flag flip rather than a support ticket. See
[Domains](domains.html) for the rotation order that avoids a gap.

Check what a receiver sees:

```sh
dig +short CNAME corsair-1._domainkey.example.com
dig +short TXT   corsair-1._domainkey.example.com
```

The TXT lookup should follow the CNAME and return `v=DKIM1; k=rsa; p=…`.

:::danger Some providers flatten CNAMEs
Cloudflare's proxy and a few managed DNS products will resolve a CNAME at
publish time and store the result. That freezes the key, and rotation then
silently breaks signing. If your provider does this, turn proxying **off** for
the `_domainkey` records.
:::

## DMARC

```
v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@example.com;
```

Tells receivers what to do when a message claiming to be from you passes neither
an aligned SPF nor an aligned DKIM check.

| Policy | Effect |
| --- | --- |
| `p=none` | Do nothing. Monitoring only |
| `p=quarantine` | Treat as suspicious — usually the spam folder |
| `p=reject` | Refuse it outright |

`quarantine` is the sensible default. Move to `reject` once you are confident
every legitimate sender for the domain is covered — including the marketing
platform, the ticketing system, and whatever else sends as you.

`rua=` gives you aggregate reports, which is how you find the sender you forgot.
Add it before tightening the policy, not after.

The generated record points `rua` at `dmarc-reports@` on the domain itself. That
address needs no mailbox: Corsair accepts mail for it, reads the reports
(gzip, zip, or plain XML), and files them under the domain, where
**Reports** in the control panel totals them by sending IP and by reporting
organisation. If you do create a mailbox or alias called `dmarc-reports`, it
receives the messages as well — the parse is in addition to delivery, not
instead of it.

Two rules decide what is filed:

- **A report must be about the domain it was sent to**, or a subdomain of it.
  A report mailed to `dmarc-reports@a.example` about `b.example` is dropped, so
  one domain cannot fill another's dashboard.
- **The sender must authenticate** — SPF or DKIM passed. Every large reporter
  signs its reports; without the check anyone could invent traffic by mailing an
  XML file.

You can keep your own `rua` instead, or as well
(`rua=mailto:dmarc-reports@example.com,mailto:you@dmarc-service.example`). A
destination on another domain has to publish a TXT record authorising it —
`example.com._report._dmarc.dmarc-service.example` with `v=DMARC1` — or
receivers will not send to it. Commercial report services publish theirs for
you.

**DMARC passes if *either* SPF or DKIM passes and aligns with the From domain.**
One is enough by design — that is what makes forwarding survivable, since
forwarding breaks SPF but preserves DKIM.

## MX

```
example.com.  MX  10  mail.example.com.
```

Where mail for the domain is delivered.

:::danger The MX record is the cutover
If you have an existing MX pointing somewhere else, replacing it is the moment
your mail starts arriving here. Do the [mailbox transfer](transfers.html) first,
verify it, then change the MX.
:::

Remove the old provider's MX records entirely. Leaving them at a worse priority
means the old host keeps receiving whenever yours is briefly unreachable, which
is the opposite of a clean cutover.

Two MX records at equal priority is how you run two mail hosts — senders pick one
and retry the other on failure.

## MTA-STS

Tells senders to require TLS when delivering to you, and to refuse to fall back to
plaintext if it fails.

Corsair serves the policy at `/.well-known/mta-sts.txt`. The mode reflects
whether the MX can actually offer STARTTLS — on a runtime where it cannot, the
policy is published as `none` rather than claiming a capability that is not
there. See [Deliverability](./deliverability.html).

```
version: STSv1
mode: none
mx: mail.example.com
max_age: 604800
```

Corsair generates the `mta-sts` CNAME. The **`_mta-sts` TXT record carrying the
policy id is not generated for you** — MTA-STS requires one, and senders will not
notice a policy change without it, so add it by hand if you are using MTA-STS
seriously:

```
_mta-sts.example.com.  TXT  "v=STSv1; id=20260810000000"
```

Bump the `id` whenever the policy changes.

:::warning Do not go straight to enforce
Going to `enforce` with a wrong MX list silently blackholes your inbound mail —
senders refuse to deliver rather than falling back. Watch the reports, confirm
the MX list is right, and only then change it.
:::

## TLS reporting

```
_smtp._tls.example.com.  TXT  "v=TLSRPTv1; rua=mailto:tlsrpt@example.com"
```

Optional. Asks senders for a daily report (RFC 8460) of how their TLS sessions to
your MX went — how many negotiated TLS, and why any did not. It is the feedback
loop that makes [MTA-STS](#mta-sts) safe to tighten: an expired certificate shows
up as `certificate-expired` failures before it becomes lost mail.

Like `dmarc-reports@`, the `tlsrpt@` address needs no mailbox; Corsair files the
JSON reports under the domain and shows them beside the DMARC ones. Entries in a
report about any other domain are dropped.

## autoconfig and autodiscover

CNAMEs that let Thunderbird and Outlook configure themselves from an email address
alone. Optional, and worth publishing — the alternative is telling every user six
hostnames.

## Checking everything

```sh
dig +short MX    example.com
dig +short TXT   example.com
dig +short TXT   _dmarc.example.com
dig +short CNAME corsair-1._domainkey.example.com
dig +short TXT   corsair-1._domainkey.example.com
```

The panel's DNS Setup tab does this for you and, when a record does not match,
shows **what it actually observed**. That is usually enough to spot the problem
immediately.

## When a record will not verify

**The provider appended the domain.** You entered `_dmarc.example.com` into a field
that already appends the zone, giving `_dmarc.example.com.example.com`. Enter just
`_dmarc`.

**Quotes were stored literally.** Some panels want the value without quotes and
store them if you paste them. `"v=spf1 …"` with the quotes in the value is not a
valid SPF record.

**Two SPF records.** Exactly one.

**It has not propagated.** A record can take up to the *previous* record's TTL to
become visible. If you lowered the TTL only when you made the change, you are
waiting for the old one.

**Proxying is on.** Cloudflare's orange cloud on a `_domainkey` record breaks it.

## Before a migration, lower your TTLs

A day before you plan to change the MX, drop its TTL to 300 seconds. Then the
cutover window is five minutes rather than however long the old TTL was.

Raise them again afterwards.
