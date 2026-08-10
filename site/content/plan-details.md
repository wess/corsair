---
title: Plan details
description: Exactly what each limit means and how it is enforced.
---

# Plan details

## Storage

Counted per account, across every domain and mailbox it owns, as the sum of
stored message sizes. Enforced at delivery: an inbound message for an account
over its limit is answered with a **452**, which is a temporary failure. The
sender retries for days, so freeing space recovers the mail rather than losing
it.

Deleting a message frees its space when it is expunged, not when it is flagged.
A client that marks a message deleted without expunging is still using the space.

## Daily limits

Two counters over a rolling 24 hours, taken from the message log:

- **In** — messages accepted for delivery to this account.
- **Out** — messages accepted from this account for delivery elsewhere.

Hitting the inbound limit produces a 452 for the rest of the window. Hitting the
outbound limit produces a **451** at submission, so the customer's mail client
reports it rather than silently queueing.

A limit of zero means unmetered.

## Mailbox transfers

An IMAP-to-IMAP copy from a previous host. The source password is encrypted at
rest and erased the moment the transfer reaches a terminal state.

Common remote folder names are mapped onto the local special-use folders, so
`[Gmail]/Sent Mail` becomes `Sent` rather than appearing beside it.

## Custom filters

Sieve scripts (RFC 5228), attached to a mailbox and run at delivery. Sieve is
deliberately not Turing-complete — no loops, no recursion, no way to call out —
so a customer's script cannot hang the delivery path.

## User self service

Lets a mailbox owner reset their own password through the recovery tool, without
the account owner doing it for them.

## Fallback domains

When mail arrives for an address that does not exist on a domain, and there is
no catch-all, it can be redirected to another domain on the same account. The
chain is followed exactly once — two domains pointing at each other is a
configuration people do create.
