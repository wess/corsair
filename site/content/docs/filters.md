---
title: Filters
description: The Sieve subset Corsair implements, and why filtering is a real language rather than a rules builder.
section: using
order: 6
short: Filters
eyebrow: Using Corsair
---

# Filters

Filters are [Sieve](https://datatracker.ietf.org/doc/html/rfc5228) scripts. Sieve
is deliberately not a general-purpose language: no loops, no recursion, no way to
call out. That is the reason it is safe to run a customer's script on the
delivery path at all.

A filter belongs to the account and can be attached to any number of mailboxes.

## Editing from a mail client

Corsair speaks ManageSieve (RFC 5804) on port **4190**, so Thunderbird's Sieve
add-on, Roundcube's filters plugin, and K-9 can edit the same scripts the panel
shows. There is no second copy: a script saved from a client is a row in the
panel's filter list, and the other way round.

| Setting | Value |
| --- | --- |
| Server | your mail hostname |
| Port | **4190** |
| Security | STARTTLS |
| Authentication | PLAIN, with your mailbox address and password |

- **Active script.** A mailbox runs one filter, the one set on the address in
  the panel. `SETACTIVE` from a client sets the same field, and an empty name
  turns filtering off. The active script cannot be deleted; deactivate it first.
- **Whose scripts.** Filters belong to the account, so ManageSieve is open only
  to a mailbox that is its owner's own account. Other mailboxes on the domain
  and agent mailboxes sign in correctly and are then told no.
- **TLS first.** Like IMAP and POP3, Corsair refuses the password until the
  connection is encrypted, so a server whose runtime cannot do STARTTLS (see
  [Client settings](client-setup.html)) cannot offer ManageSieve either.
- **Plans.** Saving, replacing, and renaming scripts needs the custom filters
  feature, as in the panel. Reading and `CHECKSCRIPT` work on every plan.
- **Limits.** A script is at most 64,000 bytes and an account holds at most
  100. Scripts are UTF-8. `MANAGESIEVE_PORT` and `MANAGESIEVE_ENABLED` change
  the listener.

Thunderbird's autoconfig format has no ManageSieve entry, so clients are not
configured for it automatically; enter the port above.

## Supported

**Control** — `if` / `elsif` / `else`, `stop`, `require` (accepted and ignored).

**Tests** — `address`, `envelope`, `header`, `exists`, `size`, `true`, `false`,
`not`, `allof`, `anyof`.

**Comparators** — `:is`, `:contains`, `:matches` (with `*` and `?`), `:regex`.

**Address parts** — `:all`, `:localpart`, `:domain`.

**Actions** — `keep`, `discard`, `fileinto` (with `:create`), `redirect`,
`reject`, `addflag`, `setflag`, `removeflag`.

## The implicit keep

If a script takes no filing action, the message is delivered to the inbox
anyway. `fileinto` suppresses that; an explicit `keep` alongside it delivers to
both.

## Examples

Newsletters out of the inbox:

```
require ["fileinto"];

if anyof (exists "list-id", header :contains "precedence" "bulk") {
  fileinto :create "Newsletters";
  stop;
}
```

Flag anything from your own domain:

```
require ["imap4flags"];

if address :domain :is "from" "example.com" {
  addflag "\\Flagged";
}
```

File by sub-address:

```
require ["fileinto", "envelope"];

if envelope :localpart :matches "to" "*+receipts" {
  fileinto :create "Receipts";
}
```

Drop something silently — no bounce, so the sender learns nothing:

```
if header :contains "subject" "unmissable opportunity" {
  discard;
}
```

## Notes

- A script that fails to compile is rejected on save.
- A script that throws at delivery time is treated as absent — the message is
  delivered to the inbox and the error is shown against the filter. A broken
  filter never loses mail.
- `reject` refuses the message with a 550. `discard` accepts and drops it.
  Rejecting tells the sender their message was filtered; discarding does not.
- Scripts stop after 100 actions.
