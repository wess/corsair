---
title: A filter cookbook
description: Sieve scripts that solve real problems — newsletters, sub-address filing, sender rules, quarantine, and the traps.
section: tutorials
order: 5
short: Filter cookbook
eyebrow: Tutorial
---

# A filter cookbook

Working Sieve scripts for the things people actually want. Copy one, change the
strings, save it. [Filters](../filters.html) is the reference for what the
language supports; this page is the recipes.

Every script here compiles against Corsair's Sieve subset. A script that fails to
compile is rejected on save, so you find out immediately rather than at delivery
time.

## The rules you must know first

**Implicit keep.** If a script takes no filing action, the message is delivered to
the inbox anyway. You cannot lose mail by forgetting a `keep`.

**`fileinto` cancels the implicit keep.** File somewhere and it goes there, not
both places. Write an explicit `keep` alongside if you want both.

**`stop` ends the script.** Everything filed so far stands. Without it, later
rules keep matching and you get surprising results.

**A broken filter never loses mail.** A script that throws at delivery time is
treated as absent — the message is delivered to the inbox and the error is shown
against the filter.

## Newsletters out of the inbox

The single most useful filter. Bulk mail almost always identifies itself.

```
require ["fileinto"];

if anyof (
  exists "list-id",
  exists "list-unsubscribe",
  header :contains "precedence" ["bulk", "list"]
) {
  fileinto :create "Newsletters";
  stop;
}
```

`:create` makes the folder if it does not exist, so this works on a fresh mailbox
with no setup.

## File by sub-address

`you+receipts@example.com` into a Receipts folder, with no per-sender rules at
all. This is the filter that makes sub-addressing worth explaining to people.

```
require ["fileinto", "envelope"];

if envelope :localpart :matches "to" "*+receipts" {
  fileinto :create "Receipts";
  stop;
}

if envelope :localpart :matches "to" "*+shopping" {
  fileinto :create "Shopping";
  stop;
}
```

Match on the **envelope**, not the `To:` header. The header is whatever the
sender typed; the envelope is what the server was actually asked to deliver to,
and a message can reach you with your address nowhere in the headers at all.

### One rule for every tag

Rather than a block per tag, file every tagged message into a folder named after
the tag:

```
require ["fileinto", "envelope"];

if envelope :localpart :matches "to" "*+*" {
  fileinto :create "Tagged";
  stop;
}
```

Sieve has no variables in this subset, so the folder name cannot be built from
the match. Either list the tags you care about, or collect them all in one place.

## Flag mail from people who matter

```
require ["imap4flags"];

if anyof (
  address :is "from" "sam@example.com",
  address :domain :is "from" "clientcompany.com"
) {
  addflag "\\Flagged";
}
```

No `fileinto` and no `stop`, so the message still lands in the inbox — it just
arrives flagged. `addflag` adds to existing flags; `setflag` replaces them all,
which is almost never what you want.

## Route by recipient on a shared domain

Useful when a group address fans out but you want the copies filed separately.

```
require ["fileinto", "envelope"];

if envelope :is "to" "support@example.com" {
  fileinto :create "Support";
  stop;
}

if envelope :is "to" "billing@example.com" {
  fileinto :create "Billing";
  stop;
}
```

## Quarantine without losing anything

For senders you distrust but will not silently drop:

```
require ["fileinto"];

if anyof (
  header :contains "subject" ["urgent action required", "verify your account"],
  header :matches "from" "*@*.top"
) {
  fileinto :create "Quarantine";
  stop;
}
```

A folder, not `discard`. You can review a folder; you cannot review a message
that was dropped.

## Actually drop something

```
if header :contains "subject" "unmissable opportunity" {
  discard;
}
```

`discard` accepts the message and throws it away. The sender learns nothing,
which is what you want for spam — a bounce confirms the address is live.

Use `reject` instead to refuse it with a 550 during the SMTP transaction:

```
if address :is "from" "expartner@example.net" {
  reject "This address does not accept mail from you.";
}
```

`reject` tells the sender they were filtered. `discard` does not. Pick
deliberately: telling a spammer is pointless, telling a colleague their mail was
binned is polite.

## Big attachments to their own folder

```
require ["fileinto"];

if size :over 10M {
  fileinto :create "Large";
  stop;
}
```

`size` is the whole message including encoding overhead, so a 7 MB attachment is
about 9.5 MB on the wire. Set the threshold above what you mean.

## Everything from a domain, except one person

`allof` with a negated test:

```
require ["fileinto"];

if allof (
  address :domain :is "from" "noisy-vendor.com",
  not address :is "from" "myrep@noisy-vendor.com"
) {
  fileinto :create "Vendors";
  stop;
}
```

## A staged inbox

Rules run top to bottom and the first `stop` wins, so order encodes priority.

```
require ["fileinto", "imap4flags"];

# 1. Anything from the team stays in the inbox, flagged.
if address :domain :is "from" "example.com" {
  addflag "\\Flagged";
  stop;
}

# 2. Automated mail goes to Robots.
if anyof (
  header :contains "auto-submitted" "auto-generated",
  address :localpart :matches "from" ["noreply*", "no-reply*", "notifications*"]
) {
  fileinto :create "Robots";
  stop;
}

# 3. Bulk goes to Newsletters.
if anyof (exists "list-id", header :contains "precedence" "bulk") {
  fileinto :create "Newsletters";
  stop;
}

# 4. Everything else falls through to the inbox by implicit keep.
```

## Regex, when the wildcards are not enough

```
if header :regex "subject" "^\\[(TICKET|INCIDENT)-[0-9]{4,}\\]" {
  fileinto :create "Tickets";
  stop;
}
```

Prefer `:matches` with `*` and `?` where it will do. Regexes are harder to read
six months later and easier to get subtly wrong.

## Testing before you trust it

**Validate.** The panel validates on save, and there is a validate endpoint
behind it. A script that does not compile is never stored.

**Attach to one mailbox first.** A filter belongs to the account and can be
attached to any number of mailboxes. Start with one.

**Watch the folder, not the inbox.** The failure mode of a too-broad rule is mail
you never see, so check that the target folder is getting what you expect and
nothing else.

**Remember the action cap.** Scripts stop after 100 actions. No realistic filter
reaches it, but a rule that fires in a loop of `fileinto` will.

## What Sieve deliberately cannot do

No loops, no recursion, no network calls, no shelling out. That is the whole
reason it is safe to run a user's script on the delivery path. If you need
something Sieve cannot express, do it downstream — subscribe to a
[webhook](webhook-consumer.html) and act on the event outside the mail path.
