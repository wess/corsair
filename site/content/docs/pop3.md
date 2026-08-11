---
title: POP3
description: The supported command set, and an honest account of when POP3 is the wrong choice.
section: reference
order: 6
eyebrow: Reference
---

# POP3

POP3 on **995** (implicit TLS). Full email address as the username, mailbox
password as the password.

Port 110 listens but cannot be used: there is no server-side STLS, and Corsair
will not take a credential unencrypted. See [TLS](tls.html).

It exists for the clients that still want it.

## Commands

| Command | Notes |
| --- | --- |
| `CAPA` | Advertised capabilities |
| `USER`, `PASS` | Standard authentication |
| `APOP` | Digest authentication |
| `STAT` | Message count and total size |
| `LIST` | Message numbers and sizes |
| `UIDL` | Persistent unique identifiers |
| `RETR` | Fetch a message |
| `TOP` | Headers plus *n* body lines |
| `DELE` | Mark for deletion |
| `RSET` | Unmark everything |
| `NOOP` | |
| `QUIT` | Commits the deletions |

That is the whole of RFC 1939 plus `UIDL` and `TOP`. `STLS` is present in the
command table but cannot complete; use 995.

## INBOX only

POP3 has no concept of folders. A session sees `INBOX` and nothing else.

Mail filed elsewhere by a [Sieve filter](filters.html) — into `Newsletters`, into
`Junk` — is invisible over POP3. That surprises people who set up a filter and
then wonder where their mail went.

## Deletions commit at QUIT

`DELE` marks. `QUIT` commits. A connection that drops before `QUIT` deletes
nothing, which is the protocol working as intended.

`RSET` unmarks everything in the current session.

## UIDL

`UIDL` gives each message a persistent identifier, which is how a client
implements "leave messages on the server" — it records the identifiers it has
already downloaded.

Every client worth using supports it. A client that does not has to delete as it
goes, or download everything every time.

## When POP3 is right

**A device that should drain a mailbox to local storage.** An archival machine, a
system that ingests mail into something else, a printer.

**A genuinely single-device setup** where server-side state is not wanted.

## When it is wrong, which is usually

POP3 downloads and, by default, deletes. It has:

- No folders
- No flags shared between devices — read on your laptop is unread on your phone
- No server-side search
- No concept of a second client

Two devices both using POP3 against one mailbox race each other for the mail.
Whichever polls first gets it.

Use [IMAP](imap.html) unless you have a specific reason not to. If you must use
POP3, turn **off** "delete from server" in the client unless removal is the point.

## Testing by hand

```sh
openssl s_client -connect mail.example.com:995 -crlf
```

```
USER you@example.com
PASS your-password
STAT
LIST
UIDL
TOP 1 10
RETR 1
QUIT
```

Replies are `+OK` or `-ERR`, which makes POP3 the easiest of the mail protocols
to debug by hand.

## Same store

POP3 reads the same rows as IMAP, JMAP, and the webmail. A message deleted over
POP3 is gone from all of them — it is the same message, not a copy.

That is worth saying explicitly, because the POP3 mental model of "downloading my
mail" suggests otherwise. There is one copy, and `DELE` plus `QUIT` deletes it.
