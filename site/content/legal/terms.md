---
title: Terms of service
description: The rules for using the hosted Corsair mail service at mx.wess.dev, including acceptable use, limits, suspension, and what is promised during the beta.
eyebrow: Legal
---

These terms cover the **hosted mail service operated at `mx.wess.dev`**. They are
not the licence for the Corsair software — if you run Corsair on your own server,
nothing here applies to you and you set your own rules for your own users.

Last updated 12 August 2026. The service is operated by Wess Cope. Questions go
to `postmaster@wess.dev`; abuse reports go to `abuse@wess.dev`.

## This is a beta

The service is in beta, which has three consequences worth stating plainly
rather than burying:

- **It is free.** Plan prices are shown so you know what the service will cost
  when billing opens. Nothing is charged today, and no payment method is
  required. You will be told before that changes.
- **There is no uptime commitment.** The service runs on a single machine. It
  will have outages, and some of them will be because someone is changing
  something.
- **Do not make it your only copy of anything you cannot lose.** Backups are
  taken nightly and kept off the server, and they have been test-restored — but
  a beta is a bad place to keep the only copy of your business.

Mail that matters should have a second home. That is true of every mail
provider; it is more true of this one right now.

## What you may use it for

Ordinary email: sending and receiving your own mail, for yourself, your family,
your team, or your business, on domains you control.

## What you may not use it for

The list is short because the principle is short — **do not use this service to
reach people who did not ask to hear from you, and do not use it to pretend to
be someone else.**

Specifically, you may not use the service to:

- Send unsolicited bulk mail, cold outreach campaigns, or anything a reasonable
  recipient would call spam, whether or not it is legal where you are.
- Warm up sending reputation, cycle through domains, or otherwise use the
  service as infrastructure for bulk sending conducted elsewhere.
- Send phishing, fraud, malware, or any message designed to deceive the
  recipient about who sent it or what it will do.
- Forge sender addresses, or send on behalf of a domain you do not own or
  administer. The service enforces this technically as well.
- Distribute content that is illegal under United States law, or that
  facilitates violence, harassment, or the exploitation of children.
- Consume so much of the shared machine's capacity that other people's mail
  suffers.
- Resell the service, or operate a mail service for third parties on top of it,
  without agreement in writing.

**Why this matters more than it would elsewhere:** every account here shares one
sending IP address. One person sending spam damages deliverability for everyone
on the server, including me. That is the reason abuse is handled abruptly rather
than gradually.

## Your domains and your DNS

You must control every domain you send from. The service gives you the DNS
records to publish — SPF, DKIM, DMARC, and MX — and will not deliver mail
properly until they are in place.

Publishing those records is your responsibility, as is keeping them published. A
domain whose records disappear will start failing authentication at recipients,
and the service cannot fix that from this side.

## Limits

Each plan carries a storage allowance and a daily cap on messages sent and
received. The current values are shown on the Plans page in the panel and are
enforced by the server, not by good behaviour.

Hitting a cap means further messages are refused until the window resets. It is
not a penalty and there is no charge attached to it.

## Suspension and termination

I may suspend or terminate an account **immediately and without notice** for
abuse as described above, for activity that puts the server's sending reputation
at risk, or where required by law. In that case you will be told what happened
and given the chance to retrieve your data unless doing so would itself be
unlawful.

You may close your account at any time, from the panel or by asking. On closure:

- Your mailboxes stop accepting mail immediately.
- Your data is deleted after **30 days**, which is the window in which you can
  change your mind. See the [Privacy Policy](privacy.html) for exactly what is
  held and for how long.

I may also discontinue the service itself. If that happens you will get at least
**30 days' notice** and a way to export your mail, except where the service is
being shut down because of abuse or a legal requirement.

## Backups

Backups are taken nightly, encrypted before they leave the machine, and kept for
30 days. They exist so that *I* can recover the service, and you benefit from
that.

They are not a per-message undelete facility, and I do not guarantee that any
particular message can be recovered from them. Delete something you needed and
the honest answer may be that it is gone.

## What is not promised

The service is provided as it is. Within the limits the law allows, I am not
liable for lost profits, lost business, or consequential damages arising from
downtime, delivery failure, misdelivery, or data loss — including where the mail
was important.

Email is a best-effort system end to end: a message you send can be delayed,
filtered, or discarded by a recipient's server for reasons neither of us
controls, and no provider can promise otherwise.

## Changes

These terms will change as the service leaves beta and billing opens. Material
changes — anything affecting what you pay, what you may do, or what happens to
your data — will be announced by email to your account address before they take
effect.

## Getting in touch

| For | Address |
| --- | --- |
| Abuse reports | `abuse@wess.dev` |
| Anything else about the service | `postmaster@wess.dev` |

Both addresses are monitored. Abuse reports are read first.
