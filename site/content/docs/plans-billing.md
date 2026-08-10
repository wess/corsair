---
title: Plans and billing
description: How entitlements work, why an unconfigured instance is unmetered, and what happens when billing is turned on.
section: using
order: 10
short: Plans and billing
eyebrow: Using Corsair
---

# Plans and billing

Most people running Corsair for themselves can ignore this page. Leave billing
unconfigured and the instance runs unmetered.

It matters if you host mail for other people.

## Entitlement

An account's entitlement is its **plan** plus its **live subscription**. Three
cases, in the order Corsair resolves them:

1. **A live subscription** (`trialing`, `active`, or `past_due`) — that
   subscription's plan applies.
2. **No subscription** — the trial plan applies. This is what a fresh account is
   in, and it is deliberate: a self-hosted instance that never configures billing
   should still work.
3. **No plans configured at all** — the instance is **unmetered**. Every feature
   on, no caps, no limits.

Case three is a legitimate way to run a private server and is what you get if you
never touch any of this.

## What a plan controls

| Field | Controls |
| --- | --- |
| `storage_bytes` | Total storage, **per account** rather than per mailbox |
| `daily_in` | Messages received per day |
| `daily_out` | Messages sent per day |
| `max_domains` | Domains, or `null` for unlimited |
| `max_addresses` | Addresses, or `null` for unlimited |
| `features` | Feature flags, below |

Daily limits are message counts, counted from `mail_log`.

### Feature flags

| Flag | Gates |
| --- | --- |
| `fallback_domains` | Sending unmatched recipients on to another domain |
| `self_service` | Mailbox owners resetting their own passwords at `/recover` |
| `custom_filters` | Sieve filters |
| `transfers` | IMAP migration from another host |

A feature the plan does not include raises a **402**, not a 403, so the panel can
render an upgrade prompt rather than an error.

Validation always runs **before** the quota check: a malformed input is invalid
regardless of the plan. Telling someone to upgrade so they can submit a broken
request would be absurd.

## Plans are rows, not constants

They live in a table so a self-hoster can price, rename, or delete them without a
deploy — and so an instance that charges nobody can simply run one unlimited plan,
or none.

`bun scripts/seed.ts` creates a default ladder so a fresh install has something
coherent to show rather than an empty Plans screen:

| Key | Name | Storage | In/day | Out/day | Monthly | Features |
| --- | --- | --- | --- | --- | --- | --- |
| `trial` | Free Trial | 1 GB | 200 | 20 | — | none |
| `startup` | Startup | 5 GB | 200 | 50 | $1.50 | transfers |
| `small_business` | Small Business | 30 GB | 1,000 | 100 | $5.00 | transfers, filters, self-service |
| `mini_tycoon` | Mini Tycoon | 100 GB | 3,000 | 500 | $15.00 | all four |

`trial` also caps domains at 1 and addresses at 3; the paid tiers are unlimited on
both. Change any of it, or delete the lot — nothing in the code depends on these
particular rows.

## Running unmetered

The simplest configuration, and the right one for personal use.

```sh
# Leave both empty
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
```

Then either delete every plan row — genuinely unlimited — or keep one generous
plan and put every account on it.

With `STRIPE_SECRET_KEY` empty, plans still gate features and an operator can
record payment methods by hand, but nothing is ever charged. There is no code path
that would attempt it.

## Turning billing on

```sh
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

Then set `monthly_price_ref` and `yearly_price_ref` on each plan to the
provider's price identifiers.

Point the provider's webhook at `/api/webhooks/payments`. That endpoint reads the
body **verbatim** — the signature covers the exact bytes, so it verifies before
parsing.

### Card details never reach this server

The customer enters them on the provider's own hosted page. What comes back is a
brand, four digits, and an opaque reference.

There is no code path in Corsair that could accept a card number, and this is not
an oversight to be fixed. Handling card data means PCI scope, and a mail server
has no business being in it.

## Subscription states

| Status | Means | Mail flows |
| --- | --- | --- |
| `trialing` | In a trial period | Yes |
| `active` | Paid and current | Yes |
| `past_due` | Payment failed, retrying | Yes |
| `cancelled` | Ended | Falls back to the trial plan |

`past_due` still counts as live. Cutting off someone's email the moment a card
expires is how you lose a customer who was going to pay you.

Cancellation sets `cancel_at_period_end` rather than deleting immediately — a
cancelled subscription keeps serving mail until the period it was paid for runs
out.

## Quotas in practice

**Storage** is per account across every domain and mailbox. One mailbox can use all
of it. `quota.warning` and `quota.exceeded` webhooks fire before and at the cap,
so you can tell someone before mail starts being refused.

**Daily limits** reset on a rolling 24-hour window from `mail_log`. Hitting
`daily_out` means submission is refused until the window moves; hitting `daily_in`
means inbound is refused, which senders see as a temporary failure and retry.

Recompute storage by hand if you have restored a backup or deleted a lot:

```sql
-- Or let the worker's quota.recompute job do it
SELECT sum(size) FROM messages WHERE address_id = '...' AND expunged_at IS NULL;
```

## Transactions and tax

Transactions are recorded per account and readable through the API and the panel.
A tax ID can be stored per account for invoicing.

Neither is a general-purpose accounting system. If you are running this as a real
business, the provider's own records are the source of truth.

## Referrals

Each account gets a referral code, and referrals are recorded. There is no payout
logic — what you do with the data is up to you.
