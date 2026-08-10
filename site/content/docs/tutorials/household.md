---
title: Mail for a household or small team
description: Real mailboxes for people, aliases for roles, a group for everyone, a catch-all for the rest, and self-service recovery.
section: tutorials
order: 4
short: Household setup
eyebrow: Tutorial
---

# Mail for a household or small team

Thirty minutes to a domain that serves several people properly: individual
mailboxes, role addresses that forward, a group that fans out, a catch-all for
everything else, and password recovery that does not route through you.

The example is a household on `example.com`. A five-person company is the same
shape with different words.

## The plan

| Address | Kind | Goes to |
| --- | --- | --- |
| `sam@` | Mailbox | Sam |
| `alex@` | Mailbox | Alex |
| `kid@` | Mailbox | The teenager |
| `hello@` | Alias | `sam@` |
| `bills@` | Alias | `alex@` |
| `family@` | Group | `sam@`, `alex@`, `kid@` |
| everything else | Catch-all | `sam@` |

Three real mailboxes. Everything else is routing, which costs nothing and cannot
be signed into.

## 1. Create the mailboxes

**Domains → example.com → New mailbox**, once per person.

Give each a real password and hand it over out of band. This is the credential
that goes into their phone and their laptop — not a control-panel login, which
they do not need and should not have.

Each mailbox is provisioned with `INBOX`, `Drafts`, `Sent`, `Junk`, `Trash`, and
`Archive`, tagged with their IMAP special-use attributes so clients file things
correctly without being configured.

## 2. Add the role aliases

**New address → Alias.** An alias forwards to exactly one destination and has no
password, because there is no mailbox behind it.

- `hello@example.com` → `sam@example.com`
- `bills@example.com` → `alex@example.com`

Why an alias rather than a second mailbox: nobody has to check it, it cannot be
compromised, and when Sam stops handling `hello@` you repoint it in one place.

:::note Forwarded mail is SRS-rewritten
An alias that forwards to an outside address keeps the original sender, whose SPF
does not list your server — so the next hop sees a forgery. Corsair rewrites the
envelope sender with SRS so it survives. This is automatic and there is nothing
to configure.
:::

## 3. Add the group

**New address → Group**, `family@example.com`, with all three mailboxes as
destinations.

A group fans out: one message in, one copy to each destination. Use it for
anything that should reach everyone — the school, the landlord, the vet.

Groups have no password either. To *send* as `family@`, sign in as a real mailbox
and set the From address in the client.

## 4. Set the catch-all

**Domains → example.com → Settings → Catch-all**, pointed at `sam@`.

A catch-all is a mailbox that also receives anything in the domain that matched
nothing else. It is what makes `plumber@example.com` work when you invented it at
the door.

:::warning A catch-all collects spam
Once a domain is known to accept everything, dictionary attacks start filing into
it. If the volume gets bad, drop the catch-all and use sub-addressing instead —
`sam+plumber@example.com` needs no setup at all and routes to `sam@`.
:::

## 5. Understand the resolution order

For any address at the domain, Corsair tries, in order:

1. An exact match — `sam@`, `hello@`, `family@`
2. Sub-addressing — `sam+anything@` routes to `sam@`
3. The catch-all
4. The domain's fallback domain, followed exactly once

The first match wins, so an exact alias always beats the catch-all. That is why
adding `bills@` later changes nothing else.

## 6. Turn on self-service recovery

Without this, every forgotten mailbox password is your problem.

**Domains → example.com → Settings → Self-service recovery.** Then for each
mailbox, set a **recovery address** — a phone number's carrier address, a personal
Gmail, another mailbox on the domain. Anywhere the person can actually read that
is not the mailbox they are locked out of.

They then use `/recover` to reset their own mailbox password. The reset link goes
to the recovery address, never to the mailbox itself, which would be useless.

The endpoint always answers the same way whether or not the address exists.
Making it more helpful would turn it into a way to enumerate your mailboxes.

:::note This is a plan feature
`self_service` is gated. On an unmetered instance — no plans configured — every
feature is on. On a metered one, check the plan.
:::

## 7. Give each person their client settings

Full email address as the username, mailbox password, and:

| Protocol | Port | Security |
| --- | --- | --- |
| IMAP | 993 | SSL/TLS |
| SMTP | 587 | STARTTLS |

If you published the `autoconfig` and `autodiscover` CNAMEs, Thunderbird and
Outlook find all of this from the address alone. [Client settings](../client-setup.html)
has the per-client notes, including the two clients that need help.

## 8. Filters worth setting up on day one

Give each mailbox a filter that files the noise. **Filters → New filter**, then
attach it to the mailboxes that want it — a filter belongs to the account and can
be attached to any number of mailboxes.

```
require ["fileinto"];

if anyof (exists "list-id", header :contains "precedence" "bulk") {
  fileinto :create "Newsletters";
  stop;
}
```

The [filter cookbook](filter-cookbook.html) has more.

## 9. Sub-addressing, explained once to everyone

Tell the household this, because it is the single most useful thing about running
your own mail:

> Any address works with a `+tag` on the end. `sam+netflix@example.com` arrives in
> Sam's inbox. Nothing needs to be set up. If that tag starts getting spam, you
> know exactly who sold it, and a filter can bin it.

File by tag:

```
require ["fileinto", "envelope"];

if envelope :localpart :matches "to" "*+receipts" {
  fileinto :create "Receipts";
}
```

## What you ended up with

Three passwords to look after instead of seven addresses. Roles you can repoint
without telling anyone. A group that does not need a mailbox. A catch-all for the
long tail, and sub-addressing so the catch-all stays optional. And a recovery
path that does not run through you at eleven at night.

## Adding someone later

New mailbox, add them to `family@`, set a recovery address, hand over the
password. Two minutes.

## Removing someone

Delete the mailbox — the messages go with it, so
[back them up first](backup-drill.html) if that matters. Remove them from
`family@`. Repoint any alias that pointed at them. If mail should keep flowing to
a successor, turn the old address into an alias rather than deleting it, and
their mail forwards on.
