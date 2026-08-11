---
title: The control panel
description: A tour of every screen — what it shows, what it lets you do, and what to check when something looks wrong.
section: using
order: 1
short: Control panel
eyebrow: Using Corsair
---

# The control panel

The panel is at `/app`. Sign in with a **user** account — the control-panel
identity, not a mailbox password. If you are trying to read mail, you want
[the webmail](webmail.html) at `/webmail` instead.

## Overview

The landing screen. Storage against the plan, messages in and out over time, the
delivery queue, and any domain that is not fully set up.

The two numbers worth glancing at daily:

- **Queue depth.** A spike after a burst of sending is normal. Depth that keeps
  growing is not — see [Monitoring](monitoring.html).
- **Storage.** Plans cap storage per account, not per mailbox. Approaching the cap
  fires a `quota.warning` webhook before it fires a rejection.

## Domains

One row per domain, with its status. A domain is **pending** until its required
records resolve, then **active**.

Until it is active, Corsair accepts mail for the domain but refuses to send from
it. That is enforced rather than advised: sending before SPF and DKIM are
published damages the sending IP's reputation for every other domain on the
server.

Opening a domain gives you four tabs.

### DNS Setup

Every record, with its current status and — when one does not match — what was
actually observed. That observation is usually enough to spot the problem: a
provider that appended the domain to a host that was already fully qualified, a
quoted value stored with the quotes, an SPF record with two `v=spf1` entries.

Three ways to publish:

| | |
| --- | --- |
| **Publish automatically** | Corsair detects your provider from the NS records and writes them itself. Cloudflare and DigitalOcean today |
| **Copy each record** | A copy button per record |
| **Export zone file** | For a provider that imports one |

The API token you paste into the automatic option is used for one publish and
then discarded. It is never stored, because a DNS token can usually rewrite every
record on every domain in the account.

**Check DNS** re-runs the check now. The worker also re-checks pending domains
every half hour, because people publish records and never come back to press the
button.

### Addresses

Every address on the domain, and where to create more. See
[Addresses](addresses.html) for the four kinds.

### Keys

The three DKIM key pairs, with one marked active. Activating a different one
switches signing to that selector — see [Domains](domains.html) for how to rotate
without a gap.

### Settings

The catch-all, the fallback domain, and self-service recovery.

## Addresses

A flat list across every domain, which is the view you want when you are looking
for one address rather than administering a domain.

Opening an address gives you its folders with message counts, its recent
activity, and the actions: change password, set a recovery address, attach a
filter, delete.

:::note Deleting an address deletes its mail
There is no trash for this. Back up first if it matters.
:::

## Filters

Sieve scripts. A filter belongs to the **account** and can be attached to any
number of mailboxes, so a "file newsletters" rule is written once and used
everywhere.

The editor validates on save — a script that does not compile is never stored, so
you find out immediately rather than at delivery time. A script that throws at
delivery time is treated as absent: the message goes to the inbox and the error
is shown against the filter. A broken filter never loses mail.

[Filters](filters.html) is the reference; the
[cookbook](tutorials/filter-cookbook.html) has working examples.

## Transfers

Mailbox migration from another host over IMAP. Create the destination address
first — a transfer copies *into* an existing address.

Each row shows progress per folder while it runs. The source password is
encrypted at rest and erased the moment the transfer reaches a terminal state.

[Transfers](transfers.html), and
[migrating from Google](tutorials/migrate-from-google.html) end to end.

## Webhooks

Endpoints, their subscribed events, and their health.

The signing secret is shown **once**, at creation, and as a prefix thereafter. It
is a credential; an endpoint that has lost it should rotate rather than read it
back.

**Send test** delivers a signed sample synchronously and shows the exact status
and body that came back — far more useful than watching a queue.

**Events** lists every delivery with its status, attempt count, and next attempt.
Open one to see the payload and replay it.

An endpoint that fails twenty times in a row is disabled automatically, and this
screen says so. Nothing else will tell you.

[Event hooks](webhooks.html), and
[building a consumer](tutorials/webhook-consumer.html).

## Billing

Plan, subscription, payment methods, transactions, and tax ID.

With `STRIPE_SECRET_KEY` unset, Corsair runs unmetered: plans still gate features
and an operator can record payment methods by hand, but nothing is charged. That
is the right default for hosting mail for yourself.

With it set, checkout is hosted by the provider. Card details never reach this
server.

[Plans and billing](plans-billing.html).

## Account

Your control-panel identity: email, password, notification preferences,
two-factor, active sessions, and referrals.

**Two-factor** is TOTP. Turn it on — this account controls every domain.

**Sessions** lists everywhere you are signed in, with a button to revoke all the
others. Use it after losing a device.

## What the panel will not do

**Read mail.** That is [the webmail](webmail.html), signed in with a mailbox
credential. The separation is deliberate.

**Change server configuration.** Everything is environment variables read at
startup. A mail server's behaviour should be reproducible from its deployment,
not from a row someone edited. See [Configuration](configuration.html).

**Run migrations.** `bun scripts/migrate.ts up`, deliberately outside the serving
process.
