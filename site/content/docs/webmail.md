---
title: Webmail
description: The built-in three-pane client, how it signs in, and why message rendering is sanitised on the server.
section: using
order: 5
eyebrow: Using Corsair
---

# Webmail

Corsair ships a three-pane mail client at `/webmail`. Folders, message list,
reading pane.

## Your own webmail URL

Each hosted domain can use `https://webmail.example.com` instead of the
installation's shared URL. The root opens webmail directly, and the browser
keeps that hostname while reading and sending mail.

In the domain's **DNS setup**, publish the optional `webmail` CNAME. Then check
DNS and open the URL shown in **Client configuration**. Sign in with your full
mailbox address and its usual password. Sessions are separate on each hostname.

### For operators

Set `MAIL_WEBMAIL_HOST` to a public hostname pointing at your HTTPS proxy, such
as `mail.example.net`. This adds the optional CNAME to new and existing domains
when their DNS setup is opened or checked. Leave it empty to disable customer
webmail URLs. `PUBLIC_URL` remains the installation's shared URL for the panel
and account emails.

A CNAME alone does not provide HTTPS: the proxy must obtain a certificate for
each customer's `webmail` hostname. With Caddy, add this global option and
catch-all HTTPS site alongside your existing shared-host configuration:

```caddyfile
{
  on_demand_tls {
    ask http://127.0.0.1:3000/api/webmail/host
  }
}

https:// {
  tls {
    on_demand
  }
  request_body {
    max_size 40MB
  }
  reverse_proxy 127.0.0.1:3000
}
```

Merge the global option into your existing `{ ... }` block. Caddy obtains and
renews customer certificates on demand; it only receives approval for
`webmail.<domain>` where the domain is active on this installation. Unknown,
pending, and deleted domains are refused. The lookup does not fetch customer
URLs or issue certificates itself. See [Caddy's on-demand HTTPS guide](https://caddyserver.com/on-demand-tls).

Allow ACME validation to reach the proxy on ports 80 or 443. Customer webmail
certificates belong to the HTTP proxy; mail-protocol certificates are separate.
Custom webmail hosts serve the webmail client and its API; the control panel
stays at the shared hostname.

## Signing in

With the **mailbox** address and password — not a control-panel login.

That is the same credential a mail client uses, and it is a deliberately
different identity from the panel: a mailbox credential ends up in a phone that
gets lost, and it must not also unlock the account that owns every domain.

The webmail session is its own cookie (`corsair_webmail`) with a **12-hour**
lifetime, shorter than the panel's fourteen days, because a browser session on a
shared machine is far more likely to be left open.

Every webmail session is also a row on the server, so it can be ended before it
expires. Logging out revokes it (a copied cookie dies with the logout), changing
the mailbox's password ends every *other* session, and disabling or deleting the
address ends them all. A mailbox that signs in with its owner's account password
loses its sessions when that password changes.

Alias and group addresses have no password and cannot sign in. They are routing
entries.

## What it does

- Read, reply, reply-all, forward
- Compose with attachments
- Move, delete, mark read or unread, flag
- Create and delete folders
- Search
- Drafts, saved server-side so they follow you between devices

Sending goes through the same submission path as any client: the From address is
proven to belong to the caller, the message is DKIM-signed with the domain's key,
a copy is filed in Sent, and delivery is queued.

## Managing users

A mailbox that has been made a [domain administrator](domains.html#delegating-administration)
gets a Users section. It manages that domain's mailboxes with the credential it
already holds, and nothing else: no billing, DNS, or domain deletion, and
`/app` still refuses a mailbox sign-in. Every route takes the webmail session and
re-checks the grant on each call, so a mailbox not named on a domain gets 404.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/mail/admin/domains` | Domains this mailbox administers. Empty for almost every mailbox |
| GET | `/api/mail/admin/domains/:domain_id/users` | Every address on the domain |
| POST | `/api/mail/admin/domains/:domain_id/users` | Create one. 201 |
| PATCH | `/api/mail/admin/users/:address_id` | Set `name` or `disabled` |
| POST | `/api/mail/admin/users/:address_id/password` | Set a mailbox's password |
| DELETE | `/api/mail/admin/users/:address_id` | Delete it, with its mail |

Create takes `local_part`, `type` (`standard`, `alias` or `group`), and optionally
`name`, `password` (8 to 200 characters) and `destinations` (up to 50 addresses).
A mailbox made here always gets its own password and is never linked to a panel
account. The limit that applies is the domain *owner's* plan: past
`max_addresses` the answer is a 409. Agent mailboxes are not reachable from here.
Setting a password on an alias or group is a 400, and on a mailbox that signs in
with its owner's account password it is refused.

You cannot disable or delete the mailbox you are signed in to. Both are 400.

## Your own credentials

| Method | Path | Does |
| --- | --- | --- |
| POST | `/api/mail/password` | Change this mailbox's password |
| POST | `/api/mail/recovery` | Set or clear the recovery address |
| GET | `/api/mail/app-passwords` | App passwords, without secrets |
| POST | `/api/mail/app-passwords` | Create one; `password` is returned once |
| DELETE | `/api/mail/app-passwords/:app_password_id` | Revoke one |
| GET | `/api/mail/notices` | What this mailbox should be told about |

`password` takes `current_password` and `new_password` (8 to 200 characters,
different from the current one). Every other webmail session ends; this one stays.
`recovery` takes `current_password` and `recovery_address` (an email, or `null`
to clear it); the address cannot be the mailbox itself. Creating an app password
also takes `current_password`. A wrong current password is a 401 and counts as a
failed sign-in towards the per-IP ban. A mailbox that signs in with its owner's
account password cannot change it here.

`/api/mail/notices` answers a list of `{ id, level, title, body, action }`, where
`level` is `info` or `warn` and `action` (optional) is `{ label, target }`. A
notice is computed, not stored: it exists while the thing it describes does, and
there is nothing to dismiss. For a mailbox the only one today is
`recovery_missing`.

## Sanitisation

Message bodies are sanitised on the **server**, in `src/sanitize`, never in the
browser. Every message a mail server accepts is attacker-supplied by definition,
and the browser is the wrong place to decide what is safe.

Removed before the browser sees anything:

- `<script>` and every event handler attribute
- `javascript:` and `data:` URLs
- `<iframe>`, `<object>`, `<embed>`, `<form>`
- CSS that can position content outside its container
- Anything else not on the allow-list

The policy is an **allow-list**: unknown tags and attributes are dropped rather
than inspected. A deny-list has to stay complete as browsers change, and it will
not.

## Remote images

Withheld by default, with a banner offering to load them.

A remote image in an email is a tracking pixel. Loading it tells the sender the
message was opened, when, and from roughly where. Corsair does not do that on
your behalf — you ask, or it does not happen.

The banner is per message. There is no "always load" setting, because the point
is the decision.

## Search

Searches the indexed `search_text` extract maintained alongside each message row,
so common searches never read a body from the bucket.

Subject, sender, recipients, and body text. Scoped to the current folder or
across everything.

## Attachments

Downloaded through the API, streamed from wherever the body lives. Corsair does
not render them — no preview, no inline PDF viewer. Your browser or your operating
system opens the file, having been told the correct content type.

Uploads are bounded by `MAX_MESSAGE_BYTES` (25 MB by default), which is the wire
size after encoding. Base64 costs about a third, so a 25 MB limit is roughly an
18 MB attachment.

## Using something else instead

The IMAP and JMAP servers are standard. Roundcube, SnappyMail, and any JMAP
client work against them unchanged — point them at 993 with the full address as
the username.

Corsair's own webmail exists so that a fresh install is usable immediately,
without a second thing to deploy. It is not trying to be Roundcube.

## What it deliberately does not have

**No calendar.** There is no CalDAV server. Contacts are an address book shared
with [CardDAV](contacts.html), used for recipient autocomplete.

**No conversation threading beyond `thread_id`.** Messages carry a thread id and
the API exposes it; the client lists messages rather than collapsing threads.

**No per-user settings store.** Preferences that would need persisting — signature,
default folder behaviour — are not there. Use a full client if you need them.

**No offline mode.** It is a web page against an API.

**No keyboard shortcuts.** Navigation is by pointer. A full client is the answer
if you work that way.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Invalid credentials" with a password you are sure of | Panel password, not the mailbox password. Or the address is an alias |
| Signed out after a few hours | The 12-hour session expired. Working as designed |
| A message renders as plain text | It had no HTML part, or the HTML was entirely stripped as unsafe |
| Images missing | Withheld by default. Use the banner |
| Attachment will not upload | Over `MAX_MESSAGE_BYTES`, or the reverse proxy's body limit is lower. Set `client_max_body_size` to match |

The last one catches people: nginx defaults to 1 MB, which silently rejects
almost every attachment. Set it above `MAX_MESSAGE_BYTES`.
