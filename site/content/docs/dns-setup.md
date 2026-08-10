---
title: DNS setup
---

# DNS setup

Every record Corsair asks for, what it does, and what happens without it.

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

## Verification

A TXT record containing a token unique to your domain. It proves you control the
domain before Corsair will route mail for it — otherwise anyone could add
someone else's domain and start receiving their mail.

## SPF

```
v=spf1 include:spf.example-host.com -all
```

Lists the servers allowed to send as your domain. `-all` means "and nobody
else". The check is by prefix, not exact match, so you can add other senders:

```
v=spf1 include:spf.example-host.com include:_spf.google.com -all
```

> SPF has a hard limit of ten DNS-querying mechanisms. Every `include:` counts,
> and so does every `include:` inside them. Blowing the budget is a permanent
> error, and the effect is that your SPF stops working entirely.

## DKIM

Published as a **CNAME**, not a TXT record. A 2048-bit key does not fit in a
single TXT string, half the DNS control panels in the world mangle the chunked
form, and a CNAME lets the key be rotated on the server without you touching
anything.

Three selectors are created per domain. Only the first has to exist; the others
are there so a rotation is a flag flip rather than a support ticket.

## DMARC

```
v=DMARC1; p=quarantine;
```

Tells receivers what to do when a message claiming to be from you passes
neither an aligned SPF nor an aligned DKIM check. `quarantine` is the sensible
default. Move to `p=reject` once you are confident every legitimate sender for
the domain is covered.

DMARC passes if **either** SPF or DKIM passes *and* aligns with the From domain.
One is enough by design — that is what makes forwarding survivable, since
forwarding breaks SPF but preserves DKIM.

## MX

Where mail for the domain is delivered. If you have an existing MX pointing
somewhere else, replacing it is the moment your mail starts arriving here — do
the mailbox transfer first.

## Checking

The DNS Setup tab shows the status of each record and, when one does not match,
what was actually observed. That is usually enough to spot the problem: a
provider that appended the domain to a host that was already fully qualified, a
quoted value that was stored with the quotes, an SPF record with two `v=spf1`
entries.

Propagation is real. A record can take up to the previous record's TTL to become
visible.
