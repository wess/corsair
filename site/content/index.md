---
title: Professional email that you actually own
description: Open source email hosting. Unlimited domains, unlimited mailboxes, on your own server.
---

# Professional email shouldn't cost so much

Corsair is open source email hosting you run yourself. Unlimited domains,
unlimited mailboxes, and no per-seat pricing — because the cost of a mailbox is
disk and bandwidth, not a subscription tier.

It is the mail server *and* the control panel: SMTP, IMAP, and POP3 in one
process, backed by PostgreSQL and any S3-compatible bucket.

[Read the docs](docs/index.html) · [Source on GitHub](https://github.com/wess/corsair)

## What you get

- **Your domains.** Add a domain, publish the DNS records Corsair generates,
  and it starts receiving mail. A live checker tells you which record is still
  missing rather than making you guess.
- **Every kind of address.** Standard mailboxes, aliases that forward, groups
  that fan out to several people, and a catch-all per domain. Plus
  sub-addressing — `you+receipts@` lands in `you@` with no setup.
- **Real authentication.** DKIM signing with rotatable keys, SPF and DMARC
  evaluation on the way in, and SRS on forwarded mail so it survives the next
  hop.
- **Any mail client.** IMAP4rev1 with IDLE and UIDPLUS, POP3, and automatic
  configuration for Thunderbird and Outlook so a customer types an address, not
  six hostnames.
- **Sieve filters.** The standard mail filtering language — not a bespoke
  rules builder that does eighty percent of what you need.
- **Migration.** Copy an existing mailbox in over IMAP from whoever hosts it
  now, folder structure intact.

## Why self-host mail

The usual answer is cost, and at a few dozen mailboxes it is a real one. The
better answer is that email is the root of every other account you own. Password
resets go there. If your mail is a free tier at a company that can close your
account by algorithm, so is everything else.

Running it yourself is not free of work — you need a static IP, a PTR record,
port 25 outbound, and a certificate. Corsair does not pretend otherwise; the
[getting started guide](docs/getting-started.html) says exactly what the host
needs before any of this is reachable mail.

## Getting started

```sh
git clone https://github.com/wess/corsair
cd corsair
bun install
bun run db:up && bun run migrate && bun run seed
bun run dev
```

Then open the control panel at `/app` and add your first domain.
