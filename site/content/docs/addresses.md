---
title: Addresses
description: The four kinds of address, sub-addressing, folders, passwords, and recovery.
section: using
order: 3
eyebrow: Using Corsair
---

# Addresses

An address is a mailbox credential or a routing entry. Which one it is depends on
its kind, and the difference decides whether there is anything to sign into.

## The four kinds

| Kind | Password | Mailbox | What it does |
| --- | --- | --- | --- |
| `standard` | Yes | Yes | An ordinary mailbox |
| `catchall` | Yes | Yes | A mailbox that also receives anything unmatched in the domain |
| `alias` | No | No | Forwards to exactly one destination |
| `group` | No | No | Forwards to several destinations at once |

Only `standard` and `catchall` carry a password hash. Aliases and groups are
routing entries — there is nothing to sign into because there is no mailbox
behind them.

### Standard

A person's mailbox. Created with a password, provisioned with six folders, and
reachable over IMAP, POP3, JMAP, and the webmail.

### Alias

`hello@example.com` → `sam@example.com`. One destination.

Use an alias for a role rather than a second mailbox: nobody has to check it, it
cannot be compromised, and repointing it later is one edit.

An alias can forward **outside** the domain. When it does, Corsair rewrites the
envelope sender with SRS — the original sender's SPF does not list your server,
so without the rewrite the next hop sees a forgery. This is automatic.

### Group

`family@example.com` → several mailboxes. One message in, one copy to each
destination.

Same SRS handling for outside destinations. No password, so to *send* as the group
you sign in as a real mailbox and set the From address in the client.

### Catch-all

A mailbox that also receives anything in the domain matching nothing else. One
per domain, set in the domain's settings rather than on the address.

## Sub-addressing

`you+anything@example.com` arrives in `you@example.com`. No configuration, no
setup, and it works for every standard mailbox immediately.

This is the most useful thing about running your own mail, and worth explaining to
everyone who has a mailbox:

> Give a different tag to every service. If `you+shoes@example.com` starts getting
> spam, you know exactly who sold your address — and a one-line filter bins it
> without affecting anything else.

File by tag:

```
require ["fileinto", "envelope"];

if envelope :localpart :matches "to" "*+receipts" {
  fileinto :create "Receipts";
}
```

Match on the **envelope**, not the `To:` header. The header is whatever the sender
typed; the envelope is what the server was actually asked to deliver to.

:::note Some sites reject `+` in an address
It is legal in an email address and always has been. When a form refuses it, use a
dedicated alias instead — that is what aliases are for.
:::

## Resolution order

For any address at a hosted domain, in order:

1. An exact match
2. Sub-addressing — `user+tag@` → `user@`
3. The domain's catch-all
4. The domain's fallback domain, followed exactly once

First match wins, so adding a real address always takes precedence over the
catch-all that was covering it.

No match is a **rejection at SMTP time** with a 550, not an accept-then-bounce. A
bounce to a forged sender is backscatter.

## Folders

Every mailbox is provisioned with six, each tagged with its IMAP special-use
attribute so clients file things correctly without being configured:

| Folder | Special use |
| --- | --- |
| `INBOX` | `inbox` |
| `Drafts` | `drafts` |
| `Sent` | `sent` |
| `Junk` | `junk` |
| `Trash` | `trash` |
| `Archive` | `archive` |

Clients can create more. Hierarchy uses `/` as the delimiter, so
`Projects/Corsair` is a child of `Projects`.

A message scored at or above the junk threshold is filed in `Junk` rather than
rejected. The scorer is deliberately conservative — a false positive on real mail
is far worse than a false negative.

## Passwords

The mailbox password is **not** the control-panel password. Two separate
identities, deliberately:

- A **user** signs into the panel and owns domains.
- An **address** signs into mail clients and owns messages.

A mailbox credential ends up in a phone, a laptop, and a printer. One of those
will eventually be lost, and when it is, it must not also unlock the account that
owns every domain.

Change one in the panel: **Addresses → the address → Change password**. Every
client using it will need updating; there is no way around that.

## Recovery

With self-service recovery enabled on the domain, set a **recovery address** per
mailbox — a personal account elsewhere, another mailbox on the domain, anywhere
the person can actually read.

They then reset their own password at `/recover`. The link goes to the recovery
address, never to the mailbox itself, which would be useless to someone locked
out of it.

The request endpoint answers identically whether or not the address exists.

## Activity

Each address has an activity view: what arrived, what was sent, what was rejected
and why. This is the first place to look when someone says a message never
arrived — it usually shows the rejection with its reason.

## Deleting

Deleting an address deletes its messages. There is no trash for this.

If someone is leaving and their mail should keep flowing to a successor, **convert
the address to an alias** pointing at the successor rather than deleting it. Mail
keeps arriving, nothing bounces, and the person's old correspondents are not
generating failures.

## Limits

Plans cap `max_addresses` per account. An unmetered instance — no plans
configured — has no cap.

Storage is per **account**, not per mailbox, matching how the quota is actually
enforced. One mailbox can use all of it.
