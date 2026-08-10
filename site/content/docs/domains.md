---
title: Domains
description: Adding a domain, verifying it, rotating DKIM keys, fallback domains, and removing one safely.
section: using
order: 2
eyebrow: Using Corsair
---

# Domains

A domain is the unit of routing and the unit of proof. Corsair accepts mail for
domains it hosts and refuses everything else, and it will not send from a domain
until that domain's authentication records exist.

## Adding one

**Domains → New domain.** Corsair normalises what you type — case, a trailing
dot, an accidental `https://` — and then generates:

- a **verification token**, unique to the domain
- **three DKIM key pairs**, with the first active
- the full **record set** to publish

Nothing routes yet. The domain is **pending** until its required records resolve.

## Pending versus active

| State | Receives mail | Sends mail |
| --- | --- | --- |
| Pending | Yes | No |
| Active | Yes | Yes |

Accepting before verification is deliberate — you may be migrating and want mail
arriving before you have finished DNS. Refusing to *send* is also deliberate, and
firmer: sending from a domain whose SPF and DKIM are not published damages the
sending IP's reputation for every other domain on the server.

## Verifying

Press **Check DNS**. The worker also re-checks pending domains every half hour on
its own, because people publish records and never come back to press the button.

When a record does not match, the panel shows what it actually observed. The
recurring causes:

- The provider appended the domain to a host that was already fully qualified,
  giving `_dmarc.example.com.example.com`
- A quoted value stored **with** its quotes
- Two `v=spf1` records, which is a permanent error that stops SPF working
  entirely
- The record is correct but has not propagated — a record can take up to the
  previous record's TTL to become visible

[DNS setup](dns-setup.html) covers every record and what breaks without it.

## Publishing automatically

If the domain's DNS is at Cloudflare or DigitalOcean, Corsair detects the
provider from the NS records and can write all ten records itself. Paste an
API token and press publish.

:::note The token is used once and discarded
It is never stored. A DNS API token can usually rewrite every record on every
domain in the account, and holding one to save a paste is a bad trade. If you
need to publish again later, you paste it again.
:::

Scope the token as tightly as the provider allows — Cloudflare's **Zone → DNS →
Edit**, restricted to the one zone.

Manual setup, the live checker, and a zone-file export are always available too.

## DKIM keys and rotation

Three key pairs are created per domain. Only the first has to be published; the
others exist so a rotation is a flag flip rather than a support ticket.

They are published as **CNAMEs**, not TXT records. A 2048-bit key does not fit in
a single TXT string, half the DNS control panels in the world mangle the chunked
form, and a CNAME lets the key rotate on the server without you touching DNS
again.

### Rotating without a gap

1. **Publish the CNAME for the next selector** — `corsair-2._domainkey` — and wait
   for it to resolve. Signing has not changed; you are only making the key
   available.
2. **Activate it** in Domains → Keys. New mail signs with selector 2.
3. **Leave selector 1 published** for at least a week. Mail already in flight was
   signed with it, and a receiver that verifies late needs the record to still be
   there.
4. Remove selector 1's CNAME once nothing signed with it can plausibly still be
   in transit.

Rotating in the other order — activating before the record resolves — means every
message signs with a key nobody can verify, which is worse than not signing at
all.

## Catch-all

A catch-all is a **mailbox** that also receives anything in the domain that
matched nothing else. Set it in Domains → Settings.

It is the last step in recipient resolution, after an exact match and after
sub-addressing. So adding a real address later always takes precedence, and
nothing needs rewiring.

:::warning A catch-all attracts spam
Once a domain is known to accept everything, dictionary attacks file into it. If
the volume gets bad, drop it — [sub-addressing](addresses.html) gives you
`you+anything@` with no setup and no catch-all.
:::

## Fallback domains

A fallback sends unmatched recipients on to another domain, followed **exactly
once**. Following it twice is how you build a loop, so Corsair does not.

Use it when consolidating: `oldcompany.com` falls back to `newcompany.com`, and
`sam@oldcompany.com` reaches `sam@newcompany.com` without you recreating every
address.

This is a plan feature (`fallback_domains`). On an unmetered instance — no plans
configured — everything is on.

## Recipient resolution, in order

For any address at a hosted domain:

1. An exact address match
2. Sub-addressing — `user+tag@` routes to `user@`
3. The domain's catch-all
4. The domain's fallback domain, once

No match is a rejection at SMTP time with a 550. Corsair does not
accept-then-bounce: a bounce to a forged sender is backscatter, and refusing
during the transaction puts the problem back where it belongs.

## Self-service recovery

Enable it per domain and set a **recovery address** per mailbox, and the mailbox
owner can reset their own password at `/recover` without going through you.

The reset link goes to the recovery address, never to the mailbox itself — which
would be useless to someone locked out of it.

The request endpoint answers identically whether or not the address exists.
Making it more helpful turns it into a way to enumerate your mailboxes.

A plan feature (`self_service`).

## Removing a domain

Deleting a domain deletes its addresses, and deleting an address deletes its
mail. There is no trash.

Before you do:

1. **Back up.** [Backups](backups.html).
2. **Remove the MX first** and let the TTL expire, so senders stop trying to
   deliver here before the domain stops existing.
3. **Check for aliases pointing at it** from other domains.

If you only want to stop *sending* from a domain, remove its SPF include instead.
Deleting is for a domain you are finished with.

## Several domains, one account

There is no limit beyond the plan's `max_domains`, and each has its own DKIM
keys, catch-all, and addresses. They share the account's storage quota, daily
limits, and filters — a filter belongs to the account and can be attached to
mailboxes on any domain.

The same server sends for all of them, which is why one domain's bad sending
behaviour affects the others. That is the reason the pending/active distinction
is enforced rather than advisory.
