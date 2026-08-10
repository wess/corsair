---
title: Introduction
description: What Corsair is, what it is not, and the shape of the system before you install it.
section: start
order: 2
eyebrow: Start here
---

# Introduction

Corsair is self-hostable email hosting. It is both halves of the job: the mail
server that speaks SMTP, IMAP, POP3, and JMAP, and the control panel where you
add domains, create mailboxes, and watch the queue drain.

You add a domain, publish the DNS records it generates, create mailboxes, and
point any mail client at it. That is the whole product.

## What it is

**One process.** `bun src/start.ts` starts every listener — the MX on port 25,
submission on 587 and 465, IMAP on 143 and 993, POP3 on 110 and 995, the HTTP
API, the panel, the webmail, and the background worker. You can split the HTTP
tier out later; you do not have to start there.

**Two dependencies.** PostgreSQL holds every row. An S3-compatible bucket holds
message bodies. The bucket is optional — without one, bodies stay inline in
Postgres, which works and is simpler, but puts mail volume through the WAL.

**One copy of the mail.** IMAP, JMAP, POP3, and the webmail all read the same
`messages` and `folders` rows. There is no per-protocol copy and no
synchronisation step, which is why a message delivered over SMTP is instantly
visible everywhere else.

**No telemetry.** Nothing phones home. There is no code path that sends your
data anywhere except to the SMTP servers you are delivering mail to, and to a
webhook endpoint if you configure one.

## What it is not

**Not a managed service.** Nobody is watching your queue. If your IP lands on a
blocklist, you are the one who files the delisting request.

**Not a groupware suite.** There is no calendar, no contacts server, no chat.
Corsair does email.

**Not a spam-filtering product.** There is a heuristic scorer that files obvious
junk into the Junk folder, and it is deliberately conservative — a false positive
on real mail is far worse than a false negative. If you need aggressive
filtering, put a dedicated filter in front of it.

**Not zero-work.** See [Prerequisites](prerequisites.html).

## The shape of it

```
                      ┌──────────────┐
     port 25 ────────►│  SMTP  (MX)  │──┐
     587 / 465 ──────►│  submission  │  │
                      └──────────────┘  │
                                        ▼
     993 / 143 ──────►┌──────────────┐  ┌──────────┐   ┌────────────┐
     995 / 110 ──────►│  IMAP / POP3 │◄─┤ Postgres │   │   bucket   │
                      └──────────────┘  │ metadata │   │   bodies   │
                                        └──────────┘   └────────────┘
     3000 ───────────►┌──────────────┐        ▲               ▲
                      │ API + panel  │────────┤               │
                      │ webmail      │        │               │
                      │ JMAP         │────────┘               │
                      └──────────────┘                        │
                      ┌──────────────┐                        │
                      │    worker    │────────────────────────┘
                      └──────────────┘
```

Metadata — folder, UID, flags, envelope, size, a searchable text extract — lives
in Postgres. Bodies live in the bucket. That split is what makes IMAP fast:
`SELECT`, `FETCH FLAGS`, `SEARCH`, and `SORT` are what a client runs constantly
and none of them need a body. Only `FETCH BODY[…]` does, and then exactly one
object is read.

[The architecture page](architecture.html) goes through this properly.

## Who it is for

**Someone hosting their own mail.** A domain, a handful of mailboxes, a small
VPS. This is the case Corsair is best at, and the one where the unmetered
defaults are correct — leave billing unconfigured and no limits apply.

**A team or a household.** Aliases, groups, a catch-all, per-mailbox filters, and
optional self-service password recovery so you are not the help desk.

**Someone running mail *for* other people.** Plans gate storage, daily message
counts, and features. With `STRIPE_SECRET_KEY` set, checkout is hosted by the
provider and settled over a signed webhook — card details never reach this
server, and there is no code path here that could accept a card number.

## Why self-host mail at all

The usual answer is cost, and at a few dozen mailboxes that is a real answer.

The better answer is that email is the root of every other account you own.
Password resets go there. If your mail is a free tier at a company that can close
your account by algorithm, then so is everything else you own.

The honest counterweight: deliverability is a reputation system, and a new IP has
no reputation. Corsair does everything on its side correctly — SPF, DKIM, DMARC,
SRS on forwards, a matching PTR — but you still start from zero and build up. If
you send newsletters to strangers, use a relay that already has reputation. If
you send mail to people who know you, you will be fine.

## License

MIT. Fork it, run it, sell it. There is no open-core split, no feature held back
for a paid tier, and no license key.
