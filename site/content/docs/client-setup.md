---
title: Client settings
---

# Client settings

| Protocol | Port | Security |
| --- | --- | --- |
| IMAP | 993 | SSL/TLS |
| IMAP | 143 | STARTTLS |
| POP3 | 995 | SSL/TLS |
| SMTP | 465 | SSL/TLS (implicit) |
| SMTP | 587 | STARTTLS |

**Username is always the full email address** — not the part before the `@`. A
bare local part would be ambiguous across the domains on the server.

**Password is the mailbox password**, which is not your control-panel password.
They are separate identities on purpose: a mailbox credential ends up in a phone
that gets lost, and it must not also unlock the panel.

## Automatic configuration

If you published the `autoconfig` and `autodiscover` CNAMEs, Thunderbird and
Outlook find these settings from the email address alone.

## Per-client notes

### Apple Mail and iOS

Choose "Other Mail Account" rather than any of the branded options. Apple Mail
occasionally offers to "automatically configure" and gets the outgoing port
wrong; set 587 with STARTTLS explicitly if sending fails.

### Gmail app

Under "Add account → Other". Gmail will fetch over IMAP but sends through its
own servers unless you also configure the SMTP settings, which it asks for
separately — mail sent without doing so will not be DKIM-signed by your domain.

### Thunderbird

Works from the address alone if `autoconfig` is published. Otherwise "Configure
manually" and enter the table above.

### Outlook

Modern Outlook resists non-Microsoft IMAP accounts. Use "Advanced setup → IMAP"
and enter the settings by hand if autodiscover does not take.

### Alias and group addresses

They have no password and cannot be signed into. They are routing entries: mail
addressed to them is forwarded. To *send* as an alias, sign in as a real mailbox
on the same account and set the From address in your client.
