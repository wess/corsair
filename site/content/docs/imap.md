---
title: IMAP
description: Advertised capabilities, supported commands, resynchronisation with CONDSTORE and QRESYNC, and the two behaviours that make IMAP correct rather than merely working.
section: reference
order: 4
eyebrow: Reference
---

# IMAP

IMAP4rev1 on **993** (implicit TLS). Username is the full email address;
password is the mailbox password.

Port 143 listens but cannot be used: Corsair has no server-side STARTTLS, and it
will not accept a credential unencrypted. See [TLS](tls.html).

## Capabilities

```
* CAPABILITY IMAP4rev1 LITERAL+ SASL-IR UIDPLUS MOVE ID UNSELECT CHILDREN
  NAMESPACE IDLE SORT ENABLE SPECIAL-USE LIST-EXTENDED WITHIN CONDSTORE QRESYNC
```

Plus, depending on connection state:

| Advertised | When |
| --- | --- |
| `LOGINDISABLED` | Not authenticated, connection not encrypted |
| `AUTH=PLAIN AUTH=LOGIN` | Not authenticated, connection encrypted |

`LOGINDISABLED` rather than accepting the password is deliberate. A client fails
at connect rather than after putting a credential on the wire in the clear — which
is what port 143 does here, since it can never be upgraded.

## Commands

### Any state

| Command | Notes |
| --- | --- |
| `CAPABILITY` | |
| `NOOP` | Also delivers pending untagged responses |
| `LOGOUT` | |
| `ID` | Client and server identification |

### Not authenticated

| Command | Notes |
| --- | --- |
| `LOGIN` | Refused without encryption when TLS is configured |
| `AUTHENTICATE` | `PLAIN` and `LOGIN`, with `SASL-IR` initial response |

### Authenticated

| Command | Notes |
| --- | --- |
| `ENABLE` | `CONDSTORE`, `QRESYNC` (which implies `CONDSTORE`) |
| `SELECT` | With `(CONDSTORE)` or `(QRESYNC (...))`; always reports `HIGHESTMODSEQ` |
| `EXAMINE` | Read-only select, same parameters |
| `CREATE` | `/` is the hierarchy delimiter |
| `DELETE` | |
| `RENAME` | |
| `SUBSCRIBE`, `UNSUBSCRIBE` | |
| `LIST` | With `LIST-EXTENDED` and `SPECIAL-USE` attributes |
| `LSUB` | |
| `STATUS` | `MESSAGES`, `RECENT`, `UIDNEXT`, `UIDVALIDITY`, `UNSEEN`, `HIGHESTMODSEQ`, `SIZE` |
| `APPEND` | Returns `APPENDUID` |
| `NAMESPACE` | |
| `IDLE` | |

### Selected

| Command | Notes |
| --- | --- |
| `FETCH` | Including partial and section addressing, `MODSEQ`, and `(CHANGEDSINCE n [VANISHED])` |
| `STORE` | Flag updates, with `(UNCHANGEDSINCE n)` |
| `COPY` | Returns `COPYUID` |
| `MOVE` | Preserves the message id |
| `SEARCH` | Including `MODSEQ n`, answered with `(MODSEQ n)` |
| `SORT` | Same `MODSEQ` criterion |
| `EXPUNGE` | Highest sequence first, or `VANISHED` once `QRESYNC` is enabled |
| `CLOSE`, `UNSELECT` | |
| `CHECK` | |
| `UID` | `FETCH`, `STORE`, `COPY`, `MOVE`, `SEARCH`, `SORT`, `EXPUNGE` |

## Special-use folders

Every mailbox is provisioned with six, tagged so clients file things correctly
without configuration:

| Folder | Attribute |
| --- | --- |
| `INBOX` | `\Inbox` |
| `Drafts` | `\Drafts` |
| `Sent` | `\Sent` |
| `Junk` | `\Junk` |
| `Trash` | `\Trash` |
| `Archive` | `\Archive` |

## The two things that make it correct

### UID allocation is atomic

```sql
UPDATE folders SET uid_next = uid_next + 1 WHERE id = $1 RETURNING uid_next
```

That takes a row lock. Two deliveries arriving at the same instant cannot be
handed the same UID.

This matters more than almost anything else in the protocol: a duplicate UID is
the one thing an IMAP client never recovers from. It caches by UID, so two
messages sharing one means the client shows the wrong body, forever, until the
account is removed and re-added.

There is a concurrency test covering it.

### EXPUNGE is emitted highest sequence first

IMAP renumbers after **every single** `EXPUNGE` response. Deleting messages 2 and
4 and reporting them in ascending order means the client deletes 2, renumbers so
the old 5 is now 4, then deletes the wrong message.

Descending order has no such problem, which is why it is the only correct order.

## Sessions and snapshots

Each session keeps a snapshot of the selected folder in UID order — the array
sequence numbers index into — and reconciles it against the database at each
command boundary.

Reconciling at a **boundary** rather than continuously is what the protocol
requires: a client that has issued `FETCH 1:5` must get five messages numbered
the way they were numbered when it asked, not renumbered mid-response.

New mail arriving during `IDLE` produces `EXISTS` and `RECENT`. Flag changes made
elsewhere produce untagged `FETCH`.

## Resynchronisation: CONDSTORE and QRESYNC

Every message carries a modification sequence, and every folder a
`HIGHESTMODSEQ`. Any change bumps both — a delivery, a flag change from any
protocol (IMAP, JMAP, webmail, the agent API), an expunge, a move. A client that
remembers the last `HIGHESTMODSEQ` it saw can ask for only what changed since.

```
a ENABLE QRESYNC
b SELECT INBOX (QRESYNC (1754823710 4127 1:300))
* 297 EXISTS
...
* OK [HIGHESTMODSEQ 4135] Highest modification sequence.
* 12 FETCH (UID 14 FLAGS (\Seen \Flagged) MODSEQ (4131))
* VANISHED (EARLIER) 41,77:79
b OK [READ-WRITE] SELECT completed.
```

The arguments are the `UIDVALIDITY` and `HIGHESTMODSEQ` the client cached, and
optionally the UIDs it knows about and a sequence-to-UID sample. Back come the
flag changes and the UIDs that disappeared, and nothing else. If `UIDVALIDITY`
has changed, the parameters are ignored and the client gets a plain `SELECT`.

The rest of the extension:

| | |
| --- | --- |
| `FETCH 1:* (FLAGS) (CHANGEDSINCE n)` | Only messages changed after `n`, with `MODSEQ` |
| `UID FETCH ... (CHANGEDSINCE n VANISHED)` | Also `VANISHED (EARLIER)` for UIDs in the set. Needs `QRESYNC` |
| `STORE 1:5 (UNCHANGEDSINCE n) +FLAGS (\Deleted)` | Skips any message changed after `n` and lists it in `[MODIFIED ...]` |
| `SEARCH MODSEQ n` | Matches messages changed at or after `n`; the reply ends `(MODSEQ highest)` |
| `STATUS INBOX (HIGHESTMODSEQ)` | Without selecting |

Once `CONDSTORE` is on — by `ENABLE`, by `SELECT (CONDSTORE)`, or by the first
command that uses a modseq — every untagged `FETCH` carries `UID` and `MODSEQ`.
Once `QRESYNC` is on, an expunge is reported as one `VANISHED` line of UIDs
rather than a run of `EXPUNGE`s. A client that enabled neither sees exactly what
it saw before.

Two properties keep it correct:

- **Modseqs are handed out under the folder's row lock**, the same way UIDs are,
  and the lock is held until the change commits. Changes therefore commit in
  modseq order, and a client can never read a `HIGHESTMODSEQ` whose change is not
  yet visible — which would make it skip that change forever.
- **Tombstones are kept for 30 days.** `VANISHED (EARLIER)` is built from them.
  For a client that has been away longer than that, Corsair cannot list exactly
  what vanished, so it reports every UID in range that is not live. The
  specification allows that, a client ignores UIDs it never had, and it is the
  only answer that cannot leave deleted mail on someone's screen. The
  sequence-to-UID sample in the `QRESYNC` arguments narrows it.

Corsair never answers `NOMODSEQ`: every folder supports modseqs.

## MOVE preserves the message id

`MOVE` updates `folder_id` and allocates a fresh UID in the target, writing a
tombstone in the source.

It is deliberately **not** implemented as copy-then-expunge, which would mint a
new row id. IMAP is satisfied either way — it only cares about UIDs — but JMAP
requires an Email's id to survive a change of mailbox, and all the protocols read
the same rows. The bug would be invisible until a JMAP client fetched the id it
had just moved.

## Everything on the wire is latin1

The session, the MIME parser, and the storage layer all handle messages as latin1
strings, so one character is exactly one byte.

IMAP literals and `RFC822.SIZE` are **octet** counts. Decoding to UTF-8 anywhere
in that path silently changes every offset, and a client asking for
`BODY[]<0.1000>` gets the wrong thousand bytes.

Decoding to real Unicode happens only at the point something displays text.

The same holds on the way out. A socket write must send those strings as latin1,
not as UTF-8 (which is what a bare `socket.write(string)` does), or every 8-bit
byte is sent twice over and each literal comes out longer than the `{n}` that
announced it. Corsair writes through one helper that also queues whatever the
socket will not take yet, so a large `FETCH` reaches a slow client whole.

## Testing by hand

```sh
openssl s_client -connect mail.example.com:993 -crlf
```

```
a LOGIN you@example.com your-password
b LIST "" "*"
c SELECT INBOX
d FETCH 1:* (FLAGS ENVELOPE)
e UID FETCH 42 (BODY[HEADER])
f SEARCH FROM "sam@example.com"
g LOGOUT
```

Every command is tagged and every reply carries its tag, so this is readable even
when several are in flight.

## Not implemented

| | |
| --- | --- |
| `COMPRESS=DEFLATE` | |
| `BINARY` | |
| `CATENATE` | |
| `NOTIFY` | `IDLE` covers the case people actually want |
| `AUTH=CRAM-MD5`, `AUTH=SCRAM-*` | `PLAIN` over TLS is the standard answer |
| `ACL`, `QUOTA` | Quota is enforced per account, not exposed per folder |

Clients negotiate down cleanly on all of these.

## Client notes

See [Client settings](client-setup.html) for the per-client quirks. The short
version: full email address as the username, prefer 993, and Corsair will refuse
a plaintext login rather than let a password cross the network unencrypted.
