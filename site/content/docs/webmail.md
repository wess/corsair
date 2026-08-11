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

## Signing in

With the **mailbox** address and password — not a control-panel login.

That is the same credential a mail client uses, and it is a deliberately
different identity from the panel: a mailbox credential ends up in a phone that
gets lost, and it must not also unlock the account that owns every domain.

The webmail session is its own cookie (`corsair_webmail`) with a **12-hour**
lifetime, shorter than the panel's fourteen days, because a browser session on a
shared machine is far more likely to be left open.

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

Uploads are bounded by `MAX_MESSAGE_BYTES` (50 MB by default), which is the wire
size after encoding. Base64 costs about a third, so a 50 MB limit is roughly a
35 MB attachment.

## Using something else instead

The IMAP and JMAP servers are standard. Roundcube, SnappyMail, and any JMAP
client work against them unchanged — point them at 993 with the full address as
the username.

Corsair's own webmail exists so that a fresh install is usable immediately,
without a second thing to deploy. It is not trying to be Roundcube.

## What it deliberately does not have

**No calendar or contacts.** Corsair does email. There is no CalDAV or CardDAV
server behind this.

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
