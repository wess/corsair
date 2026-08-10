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
| IMAP | 993 | SSL/TLS | Normal password |
| IMAP | 143 | STARTTLS | Normal password |
| POP3 | 995 | SSL/TLS | Normal password |
| POP3 | 110 | STLS | Normal password |
| SMTP | 465 | SSL/TLS (implicit) | Normal password |
| SMTP | 587 | STARTTLS | Normal password |

**Hostname** is whatever the operator set — `MAIL_IMAP_HOST`, `MAIL_SMTP_HOST`, and
so on. On most installs they are all the same name. The panel's Client
Configuration tab shows the exact values for your server.

**Username is always the full email address**, not the part before the `@`. A bare
local part would be ambiguous across the domains on the server.

**Password is the mailbox password**, which is not your control-panel password.
They are separate identities on purpose: a mailbox credential ends up in a phone
that gets lost, and it must not also unlock the panel.

Prefer 993 and 465 — implicit TLS from the first byte — over the STARTTLS ports
where the client offers a choice. STARTTLS is fine; implicit is simply harder to
downgrade.

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
port 587, STARTTLS, and **authentication on** — Apple defaults it off often enough
to be worth checking.

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
at 993 and 587 with the full address as the username.

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
| "Server does not support authentication" | You are on a plaintext port. Corsair advertises `LOGINDISABLED` rather than accepting a password in the clear. Use 993 or 465 |
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

If you must: 995 with SSL/TLS, full address as the username, and turn **off**
"delete from server" unless removal is the point.
