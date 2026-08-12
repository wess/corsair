---
title: Client settings
description: Hostnames, ports, and per-client notes for every mail client worth naming.
section: using
order: 4
short: Client settings
eyebrow: Using Corsair
---

# Client settings

The settings, then the clients that need help.

## The settings

| Protocol | Port | Security | Authentication |
| --- | --- | --- | --- |
| IMAP | **993** | SSL/TLS | Normal password |
| POP3 | **995** | SSL/TLS | Normal password |
| SMTP | **465** | SSL/TLS (implicit) | Normal password |

Port **587 with STARTTLS** also works when the operator runs the STARTTLS
terminator described in [Configuration](configuration.html). 465 is listed above
because it works on every install and needs no upgrade to get wrong.

:::tip Let your client configure itself.
Autoconfig and autodiscover name the ports this particular server offers, which
is the one answer that is right on every install. By hand, 993, 995, and 465
always work.
:::

:::note Why 587 depends on the operator.
Authenticating on 587 requires the connection to become encrypted, and that
upgrade cannot be performed by every runtime — Bun cannot upgrade a socket it
accepted. Corsair **tests this at startup** rather than assuming it, and never
advertises what it cannot perform: advertising and then failing loses mail
outright, because a peer that has committed to the upgrade cannot fall back.

Where the terminator is not deployed and the runtime cannot upgrade, **587, 143,
and 110 cannot authenticate** — Corsair refuses a credential on an unencrypted
connection, and those ports have no way to become encrypted.

Port 25 is unaffected either way. It accepts mail from other servers, encrypted
where STARTTLS is available and in plaintext where it is not, which is what
senders fall back to.
:::

**Hostname** is whatever the operator set — `MAIL_IMAP_HOST`, `MAIL_SMTP_HOST`, and
so on. On most installs they are all the same name. The panel's Client
Configuration tab shows the exact values for your server.

**Username is always the full email address**, not the part before the `@`. A bare
local part would be ambiguous across the domains on the server.

**Password** — for your own address, this is your **account password**, the same
one you use for the panel. Corsair links a mailbox to the account that owns the
domain when the addresses match, so there is one password, not two.

For a mailbox that is not a control-panel account — anyone else on your domain —
it is that mailbox's own password, which opens mail and never the panel.

993 and 465 are encrypted from the first byte. There is no upgrade to negotiate
and none to get wrong, which is why they are the better ports even on a server
where STARTTLS works.

## Automatic configuration

If the operator published the `autoconfig` and `autodiscover` CNAMEs, Thunderbird
and Outlook find all of this from the email address alone.

| Endpoint | Used by |
| --- | --- |
| `/mail/config-v1.1.xml` | Thunderbird |
| `/autodiscover/autodiscover.xml` | Outlook |

Try the address first. Fall back to manual only when it does not take.

## Apple Mail and iOS

Choose **Other Mail Account**, not any of the branded options.

Apple Mail sometimes offers to configure automatically and gets the outgoing port
wrong. If receiving works but sending fails, set the outgoing server explicitly:
**port 465, SSL/TLS**, and **authentication on** — Apple defaults it off often
enough to be worth checking, and it will otherwise try 587, which cannot
authenticate here.

On iOS: **Settings → Mail → Accounts → Add Account → Other → Add Mail Account.**
Enter the address and password, then correct the hostnames on the next screen.

## Thunderbird

Works from the address alone if `autoconfig` is published.

Otherwise **Configure manually** and enter the table above. Thunderbird's
"Re-test" button is honest — if it cannot find a working combination, the settings
really are wrong.

## Outlook

Modern Outlook resists non-Microsoft IMAP accounts and will try to convert you to
a Microsoft-hosted account.

**File → Add Account → Advanced options → Let me set up my account manually →
IMAP.** If autodiscover does not take, enter the settings by hand.

Outlook on the web cannot connect to third-party IMAP at all. That is a Microsoft
limitation.

## Gmail app and Gmail on the web

Under **Add account → Other**.

Gmail will fetch over IMAP happily, but it sends through Google's servers unless
you configure the SMTP settings too — which it asks for separately, and which is
easy to skip. Mail sent without doing so is **not DKIM-signed by your domain** and
will fail your own DMARC policy.

Configure both halves or neither.

## Mutt, aerc, and friends

```
# ~/.muttrc
set imap_user  = "you@example.com"
set imap_pass  = "your-mailbox-password"
set folder     = "imaps://mail.example.com:993"
set spoolfile  = "+INBOX"
set record     = "+Sent"
set postponed  = "+Drafts"
set trash      = "+Trash"

set smtp_url  = "smtps://you@example.com@mail.example.com:465"
set smtp_pass = "your-mailbox-password"
set from      = "you@example.com"
```

Corsair advertises `IDLE`, so `set imap_idle = yes` works.

## Any JMAP client

Session resource at `https://mail.example.com/.well-known/jmap`, authenticated
with HTTP Basic using the address and mailbox password. See [JMAP](jmap.html).

## Roundcube, SnappyMail, and other webmail

The IMAP and SMTP servers are standard, so any of them work unchanged. Point them
at **993 and 465** with the full address as the username.

Corsair also ships [its own webmail](webmail.html) at `/webmail` if you would
rather not run another thing.

## Alias and group addresses

They have **no password** and cannot be signed into. They are routing entries:
mail addressed to them is forwarded.

To *send* as an alias, sign in as a real mailbox on the same account and set the
From address in your client. Most clients call this an "identity" or "send mail
as".

## When a client will not connect

| What it says | What it means |
| --- | --- |
| "Certificate not trusted" | Self-signed, or the chain is incomplete. The server needs `fullchain.pem`, not the leaf |
| "Name does not match" | The certificate is for a different hostname than you dialled |
| "Server does not support authentication" | You are on 587, 143, or 110 and this server has no STARTTLS, so it will not accept a password in the clear. Use 993, 995, or 465 |
| "Wrong password" | Mailbox password, not the panel password. Or the address is an alias, which has none |
| "Cannot find server" | Check the hostname against the panel's Client Configuration tab |

Verify from the command line, which removes the client from the equation:

```sh
openssl s_client -connect mail.example.com:993 -servername mail.example.com
a LOGIN you@example.com your-password
a LIST "" "*"
a LOGOUT
```

## POP3, and why you probably do not want it

POP3 downloads and, by default, deletes. It has no folders, no flags shared
between devices, and no concept of a second client.

It exists for the clients that still want it, and for a device that genuinely
should drain a mailbox to local storage. For anything else, use IMAP.

If you must: **995 with SSL/TLS** (not 110, which cannot authenticate), full
address as the username, and turn **off** "delete from server" unless removal is
the point.
