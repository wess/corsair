---
title: Core concepts
description: Users, addresses, domains, folders, and the single-store model — the vocabulary the rest of the manual assumes.
section: start
order: 4
short: Core concepts
eyebrow: Start here
---

# Core concepts

Six ideas. Everything else in the manual is built on them, and the first one is
the one people get wrong.

## Users and addresses are different things

There are two entirely separate identities in Corsair, and conflating them is the
bug to avoid.

| | User | Address |
| --- | --- | --- |
| What it is | A control-panel login | A mailbox credential |
| Signs into | The panel at `/app` | SMTP, IMAP, POP3, JMAP, webmail |
| Authenticated by | Session cookie (`corsair_session`) | Password on the protocol |
| Owns | Domains, plans, webhooks, filters | Messages, folders |

An address password never signs into the panel, and a user password never signs
into a mail client. This is deliberate and it is not going to change: a mailbox
credential is typed into phones, laptops, and printers, and one of those will
eventually be lost or compromised. When that happens it must not also be the key
to the account that owns every domain.

The **first user created owns the instance** (`users.is_owner`). The claim is
made inside the INSERT and guarded by a partial unique index, so two simultaneous
signups cannot both win.

## A domain is a routing decision plus proof

Adding a domain does three things: it generates a verification token, it creates
three DKIM key pairs, and it produces the record set you have to publish.

A domain has a status. Until it is **active**, Corsair will accept mail for it but
refuses to send from it. Sending from a domain whose SPF and DKIM are not
published damages the sending IP's reputation for every other domain on the
server, so this is enforced rather than advised.

The worker re-checks pending domains every half hour, because people publish
records and never come back to press the button.

See [Domains](domains.html) and [DNS setup](dns-setup.html).

## Addresses come in four kinds

| Kind | Password | Mailbox | What it does |
| --- | --- | --- | --- |
| `standard` | Yes | Yes | An ordinary mailbox |
| `catchall` | Yes | Yes | A mailbox that also receives anything unmatched in the domain |
| `alias` | No | No | Forwards to exactly one destination |
| `group` | No | No | Forwards to several destinations at once |

Only `standard` and `catchall` carry a password hash. Aliases and groups are
routing entries — there is nothing to sign into, because there is no mailbox
behind them.

To *send* as an alias, sign in as a real mailbox on the same account and set the
From address in your client.

### How a recipient is resolved

For `anything@example.com`, in order:

1. An exact address match.
2. **Sub-addressing** — `user+tag@` routes to `user@`, with no setup at all.
3. The domain's **catch-all**, if one exists.
4. The domain's **fallback domain**, followed exactly once. (Following it twice
   is how you build a loop.)

If none match, the message is rejected at SMTP time with a 550. Corsair does not
accept-then-bounce: a bounce to a forged sender is backscatter, and refusing
during the transaction puts the problem back where it belongs.

## Folders, UIDs, and why they are fussy

Every mailbox is provisioned with six folders: `INBOX`, `Drafts`, `Sent`, `Junk`,
`Trash`, and `Archive`, each tagged with its IMAP special-use attribute so
clients put things in the right place without being told.

Two properties of IMAP shape a lot of the code:

**A UID is permanent and must be unique.** Corsair allocates one with
`UPDATE folders SET uid_next = uid_next + 1 … RETURNING`, which takes a row lock.
Two deliveries arriving at the same instant cannot be handed the same UID, and a
duplicate UID is the one thing an IMAP client never recovers from.

**Sequence numbers renumber.** They index into the folder's live messages in UID
order, so deleting message 3 makes the old 4 into the new 3. This is why
`EXPUNGE` is emitted highest-sequence-first — ascending order makes a client
delete the wrong messages.

**A move keeps the message id.** `moveTo` updates `folder_id` and allocates a
fresh UID in the target, writing a tombstone in the source. It is deliberately
not implemented as copy-then-expunge, which would mint a new row id — and JMAP
requires an Email's id to survive a change of mailbox.

## One store, five ways in

SMTP, IMAP, JMAP, POP3, and the webmail all read and write the same rows.

That is why a message delivered over SMTP is instantly visible over all of them,
and why there is no "sync" anywhere in the product. It is also why a change to
the store affects every protocol at once, which is the trade you are making.

| Protocol | Port | Identity | Notes |
| --- | --- | --- | --- |
| SMTP (MX) | 25 | None — anyone may deliver | [Reference](smtp.html) |
| SMTP (submission) | 587, 465 | Address | Requires TLS |
| IMAP | 143, 993 | Address | [Reference](imap.html) |
| POP3 | 110, 995 | Address | [Reference](pop3.html) |
| JMAP | 443 (HTTP) | Address, via Basic or cookie | [Reference](jmap.html) |
| Webmail | 443 (HTTP) | Address, via cookie | [Guide](webmail.html) |
| Panel API | 443 (HTTP) | User, via cookie | [Reference](api.html) |

## Plans gate features, even when nothing is charged

An account's **entitlement** is its plan plus its live subscription. Plans are
rows in a table, not constants, so a self-hoster can price, rename, or delete
them without a deploy.

An account with no subscription falls back to the trial plan. An instance with
**no plans at all** is unmetered: every feature on, no caps. That is a legitimate
way to run a private server, and it is what you get if you never touch billing.

A feature the plan does not include raises a **402**, not a 403, so the panel can
render an upgrade prompt rather than an error. Validation always runs first — a
malformed input is invalid regardless of the plan.

See [Plans and billing](plans-billing.html).

## Things that are deliberately never stored

Three credentials pass through Corsair and are never persisted. Do not "fix" any
of them by adding a column:

- **DNS API tokens** — used for one publish and discarded. One can usually
  rewrite every record on every domain in the account.
- **Card details** — never touch the server at all. The customer enters them on
  the provider's hosted page; a brand, four digits, and an opaque reference come
  back.
- **Transfer source passwords** — encrypted at rest and erased the moment the
  transfer reaches a terminal state. They are someone else's credential.

Reset and recovery tokens are stored only as SHA-256 hashes, and redeemed with a
`used_at IS NULL` predicate *inside* the UPDATE — checking it in a separate read
lets two concurrent requests both redeem the same link.
