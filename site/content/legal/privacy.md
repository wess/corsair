---
title: Privacy policy
description: What the hosted Corsair service at mx.wess.dev stores, why, for how long, who else can see it, and what is deliberately never kept.
eyebrow: Legal
---

This covers the **hosted mail service at `mx.wess.dev`**. If you run Corsair on
your own server, none of this applies to you — your data never reaches me, and
you are the operator making these decisions for your own users.

Last updated 12 August 2026. Operated by Wess Cope. Contact: `postmaster@wess.dev`.

## The short version

I hold your mail because you asked me to store and deliver it. I do not sell it,
mine it, or train anything on it. I can technically read it, and I say so below
rather than implying otherwise.

## What is stored

**Your messages.** Headers, bodies, and attachments, for as long as you keep
them. Bodies are held in object storage; the index, folder structure, and flags
are held in a database. This is the service — there is no version of email
hosting that does not store your email.

**Your account.** The email address you sign in with, your name if you gave one,
an Argon2id hash of your password, and your domains, mailboxes, aliases, and
filter rules. The password itself is never stored.

**Connection and delivery records.** For each message: the time, the sending and
receiving addresses, the connecting IP address, the size, and the result. For
sign-ins: the IP address and whether it succeeded. This is what makes it possible
to answer "did that message arrive?" and to notice an account being brute-forced.

## What is deliberately never stored

These are design decisions in the software, not promises about behaviour:

- **Card numbers never reach the server.** When billing opens, card details will
  be entered on the payment provider's own page. What comes back is a brand,
  the last four digits, and an opaque reference.
- **DNS API tokens are used once and discarded.** If you let the panel publish
  DNS records for you, the token is used for that one publish and never written
  down. A DNS token can usually rewrite every record on every domain in the
  account, which is too much to keep lying around.
- **Passwords for mail transfers are erased.** If you migrate mail in from
  another provider, the source password is encrypted while the transfer runs and
  destroyed the moment it finishes. It is someone else's credential.
- **Reset and recovery links are stored only as hashes**, so the database does
  not contain a working link to anyone's account.

## Who can see your mail

**You**, through the webmail, IMAP, POP3, or JMAP.

**Me**, technically. I operate the database and the servers, and there is no
architecture in which that is untrue while I am also able to fix things. What I
will actually do:

- I do not read message contents as a matter of course, and nothing samples your
  mail for analysis, model training, or product development.
- I will look at message *metadata* — sender, recipient, timestamps, delivery
  results — when investigating a delivery problem, an abuse report, or a
  security incident.
- I will look at message *contents* only when you ask me to in order to
  troubleshoot something, or where I am legally compelled to.

**Nobody else**, except the infrastructure providers below, and except where a
valid legal order requires disclosure. Your data is not sold, rented, or shared
for advertising, and there are no third-party trackers or analytics on the
panel or the webmail.

## Infrastructure providers

Running this service means other companies necessarily hold the data on their
hardware:

| Provider | What they hold |
| --- | --- |
| DigitalOcean | The server, the managed PostgreSQL database, and the object storage holding message bodies |
| Let's Encrypt | Issues the TLS certificates; sees the hostname, not your mail |
| A payment provider | Card details and billing address, when billing opens. Not in use during the beta |

## How long things are kept

These are the intervals the software actually enforces, not aspirations:

| Data | Kept for |
| --- | --- |
| Messages you keep | Until you delete them |
| Messages you delete | Purged **30 days** after deletion |
| Delivery and connection logs | **90 days** |
| Failed sign-in records | **7 days** |
| Expired sessions | **30 days** |
| Password reset and recovery tokens | **7 days** after expiry |
| Encrypted backups | **30 days** |
| Everything, after you close your account | Deleted after **30 days** |

Deleting a message removes it from your mailbox immediately. It is then purged
permanently on the schedule above, and disappears from backups as those age out.

## Security

Mail is encrypted in transit: implicit TLS on the submission, IMAP, and POP3
ports, and STARTTLS on the MX and submission ports. Where a sending or receiving
server does not support TLS, mail still flows in the clear — that is a property
of email itself, and no provider can force the other end to encrypt.

Passwords are hashed with Argon2id. Backups are encrypted before they leave the
machine. The panel and webmail are served with a content security policy, and
rendered mail is sanitised on the server against an allow-list before it reaches
your browser. Remote images are withheld by default, because they are tracking
pixels.

## Cookies

One session cookie for the panel and one for the webmail, so you stay signed in.
No advertising cookies, no analytics, no third-party scripts.

## Your data, your call

Write to `postmaster@wess.dev` and you can:

- **Get a copy** of your mail and account data.
- **Correct** anything wrong in your account.
- **Delete** individual messages, a mailbox, or the whole account.
- **Ask what is held** about you and where it came from.

Requests are answered within 30 days. Verifying that you are who you say you are
is part of that, and for an email account the bar is deliberately high.

Depending on where you live you may have additional statutory rights — under the
GDPR or the CCPA, for example. Those rights apply regardless of what this page
says, and exercising them starts at the same address.

## Changes

Material changes will be announced by email to your account address before they
take effect. The date at the top of this page is the last revision.
