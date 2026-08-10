---
title: Prerequisites
description: The four things that decide whether your mail is delivered, none of which are code.
section: start
order: 5
eyebrow: Start here
---

# Prerequisites

Read this before you buy a server. Four things decide whether your mail is
delivered or silently binned, and none of them are code. Corsair cannot fix any
of them for you and does not pretend it can.

## 1. A static IP with a matching PTR record

`CORSAIR_HOSTNAME` must resolve to the IP you send from, and that IP must
reverse-resolve back to the same name. Both directions.

```sh
$ dig +short mail.example.com
203.0.113.9
$ dig +short -x 203.0.113.9
mail.example.com.
```

The PTR is set through your **hosting provider's** control panel — it lives in
their reverse zone, not yours, and you cannot publish it yourself. Every provider
worth using offers it: DigitalOcean sets it from the droplet name, Hetzner and
Vultr have a field, AWS requires a request form for Elastic IPs.

Without a matching PTR the large providers reject on connect, before they have
seen a single message. This is the single most common reason a new mail server
does not work.

:::danger Dynamic IPs will not work
Residential and dynamic addresses are on the Policy Block List by construction.
No configuration makes them deliverable. If that is what you have, run Corsair
anyway and set `DELIVERY_TRANSPORT=relay` to hand outbound mail to a smarthost.
:::

## 2. Port 25 outbound

Most cloud providers block outbound 25 by default to limit the damage from
compromised instances. They will usually unblock it on request:

| Provider | How |
| --- | --- |
| DigitalOcean | Support ticket, usually approved for an established account |
| Hetzner | Support ticket, generally granted after a few days of account age |
| Vultr | Support ticket |
| AWS | A request form against the Elastic IP, plus a matching PTR request |
| Google Cloud | Not granted. Use a relay |
| Azure | Not granted for most subscriptions. Use a relay |
| OVH, Scaleway | Usually open by default |

Test it from the host before you commit:

```sh
$ nc -zv gmail-smtp-in.l.google.com 25
Connection to gmail-smtp-in.l.google.com port 25 [tcp/smtp] succeeded!
```

If it hangs, it is blocked. That is not fatal — set `DELIVERY_TRANSPORT=relay`
and point Corsair at a smarthost. Inbound mail on port 25 still works; only
outbound delivery changes.

## 3. A real TLS certificate

```
TLS_CERT_PATH=/etc/letsencrypt/live/mail.example.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/mail.example.com/privkey.pem
```

Corsair refuses SMTP `AUTH` and IMAP `LOGIN` without one. That is deliberate: a
password crossing the network in the clear is worse than no service, and
discovering it here is better than discovering it afterwards.

The certificate must be for `CORSAIR_HOSTNAME`. If your clients connect to
`imap.example.com` and `smtp.example.com`, either include those as SANs or point
them at the same name with CNAMEs.

Let's Encrypt via DNS-01 is the least painful route because it does not need port
80 open. See [TLS certificates](tls.html).

## 4. Permission to bind privileged ports

Ports below 1024 need root or the capability. Granting the capability is the
alternative to running a mail server as root, which it should not be:

```sh
sudo setcap 'cap_net_bind_service=+ep' "$(which bun)"
```

Then set the ports to the real ones:

```
SMTP_MX_PORT=25
SMTP_SUBMISSION_PORT=587
SMTP_SUBMISSION_TLS_PORT=465
IMAP_PORT=143
IMAP_TLS_PORT=993
POP3_PORT=110
POP3_TLS_PORT=995
```

The provided `Dockerfile` already does the `setcap` and then drops to an
unprivileged user.

## Sizing the host

Corsair is not demanding. The floor is set by PostgreSQL and by how much mail you
keep.

| Mailboxes | vCPU | RAM | Disk (excluding bodies) |
| --- | --- | --- | --- |
| 1–10 | 1 | 1 GB | 10 GB |
| 10–100 | 2 | 2 GB | 25 GB |
| 100–1000 | 4 | 8 GB | 100 GB |

With `STORAGE_BUCKET` configured, message bodies live in object storage and the
disk figure above is metadata only — a few kilobytes per message. Without a
bucket, add the full size of every message you intend to keep.

See [Scaling and performance](scaling.html) for the detail.

## A clean IP

Check the address against the common blocklists **before** you commit to it.
Cheap VPS ranges are frequently listed before you ever boot the machine, and a
provider will usually reassign you a different address if you ask early.

```sh
# Reverse the octets and query. 203.0.113.9 → 9.113.0.203
dig +short 9.113.0.203.zen.spamhaus.org
dig +short 9.113.0.203.bl.spamcop.net
```

An answer means listed. No answer means not listed by that service.

## A domain you control the DNS for

You need to publish ten records. If the domain's DNS is at Cloudflare or
DigitalOcean, Corsair can write them itself given an API token — used once, never
stored. Otherwise you paste them, or import the zone file it exports.

## The checklist

Before you install anything:

- [ ] Static IP, PTR set, forward and reverse agree
- [ ] Outbound port 25 confirmed open, or a relay chosen
- [ ] Hostname decided and resolving
- [ ] DNS control for the domain you will host
- [ ] IP checked against blocklists
- [ ] A plan for certificates

With those, [Your first production server](tutorials/first-server.html) takes
about an hour.
