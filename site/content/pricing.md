---
title: Pricing
description: Corsair is free and open source. The plans exist for operators who resell it.
---

# Pricing

**Corsair itself is free.** It is MIT licensed. Run it on your own hardware for
as many domains and mailboxes as the disk holds, and pay nobody.

The plan system exists because Corsair is also the software behind a hosting
*business*, and an operator reselling it needs storage limits, send limits, and
feature tiers. If you are running it for yourself, delete the plans or leave the
one unlimited plan in place and never look at the Billing screen again.

## The default plan ladder

These are what `bun run seed` creates. They are rows in the `plans` table —
rename them, reprice them, or drop them.

| Plan | Storage | Daily in / out | Monthly | Yearly |
| --- | --- | --- | --- | --- |
| Free Trial | 1 GB | 200 / 20 | Free | Free |
| Startup | 5 GB | 200 / 50 | $1.50 | $18.00 |
| Small Business | 30 GB | 1,000 / 100 | $5.00 | $60.00 |
| Mini Tycoon | 100 GB | 3,000 / 500 | $15.00 | $180.00 |

## Plan-gated features

| Feature | Trial | Startup | Small Business | Mini Tycoon |
| --- | --- | --- | --- | --- |
| Domains | 1 | Unlimited | Unlimited | Unlimited |
| Addresses | 3 | Unlimited | Unlimited | Unlimited |
| Mailbox transfers | — | Yes | Yes | Yes |
| Custom Sieve filters | — | — | Yes | Yes |
| User self service | — | — | Yes | Yes |
| Fallback domains | — | — | — | Yes |

Corsair does not process payments itself. Card details never reach the server —
the panel records only what a payment provider hands back for display, and the
`payment_methods` table has no field that could hold a card number.

## Running it unmetered

Delete every row from `plans` and Corsair falls back to a single unlimited
entitlement: no storage cap, no daily limits, every feature on. That is the
right configuration for a private server and it needs no code change.
