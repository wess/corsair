---
title: Transfer policy
---

# Transfer policy

## What you are agreeing to

Starting a transfer means giving Corsair credentials for a mailbox on another
service and asking it to sign in and copy the contents. By starting one you
confirm you are entitled to access that mailbox.

## What happens to the credentials

The source password is encrypted at rest with the instance's key and erased the
moment the transfer reaches a terminal state — completed, failed, or cancelled.
It is used only to authenticate to the server you named.

## What is copied

Every selectable folder, with flags and original dates. Nothing is deleted from
the source: a transfer is a copy, and the original mailbox is untouched.

## What can go wrong

- **Duplicates.** Running a transfer twice copies the messages twice. Use the
  "newer than" option on a second pass.
- **Rate limits.** Large providers throttle IMAP. A big mailbox can take hours.
- **App-specific passwords.** Providers with two-factor authentication usually
  require one. Your normal password will simply fail.

## Failures

A failed transfer keeps whatever it had already copied. The error is shown
against the transfer so you can tell a wrong password from an unreachable
server.
