---
title: Transfers
---

# Transfers

A transfer copies an existing mailbox into Corsair over IMAP, folder structure
intact, from any host that speaks it.

## Before you start

1. **Create the destination mailbox first.** A transfer copies *into* an
   existing address.
2. **Do not move the MX yet.** Transfer, verify, then cut over. New mail keeps
   arriving at the old host while the copy runs and is picked up by a second
   pass.
3. **Find the source IMAP hostname.** Not the webmail address — the IMAP one.
   Usually `imap.<provider>` on port 993.

## What gets copied

Every selectable folder. Common names are mapped onto the local special-use
folders — `[Gmail]/Sent Mail` becomes `Sent`, `Deleted Items` becomes `Trash` —
so you do not end up with two of each.

Flags are preserved. Message dates are preserved, so a transferred mailbox sorts
correctly rather than showing everything as arriving today.

## Limits

- **Message limit** — stop after this many messages.
- **Size limit** — stop once this many megabytes have been copied.
- **Newer than** — only messages at or after this date. Applied by the *source*
  server, so old mail is never transferred and discarded.

## Credentials

The source password is encrypted at rest and erased the moment the transfer
reaches a terminal state. It is someone else's credential and there is no reason
to keep it once the copy is done.

If the source requires an app-specific password — Gmail and Fastmail both do —
generate one there and use it here.

## Cutting over

1. Run the transfer and check the message counts.
2. Change the MX record to point at Corsair.
3. Wait for the old TTL to expire. Mail may arrive at either host during this
   window; that is unavoidable and is why step 4 exists.
4. Run the transfer again. Already-copied messages are re-copied, so the second
   pass is best run with a `newer than` date set to the day of the cutover.
