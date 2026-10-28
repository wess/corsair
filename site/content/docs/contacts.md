---
title: Contacts (CardDAV)
description: One address book per mailbox, synced to phones and desktop clients over CardDAV and used by the webmail's recipient autocomplete.
section: reference
order: 6.5
short: Contacts (CardDAV)
eyebrow: Reference
---

# Contacts (CardDAV)

Every mailbox has one address book. Phones and desktop clients sync it over
CardDAV ([RFC 6352](https://datatracker.ietf.org/doc/html/rfc6352)), and the
webmail reads the same rows: a contact added on your phone autocompletes in
compose, and one added in the webmail turns up on your phone at its next sync.

CardDAV runs on the same HTTPS address as the panel and the webmail. There is no
extra port.

| Setting | Value |
| --- | --- |
| Server | the panel's hostname, e.g. `mail.example.com` |
| Path | `/dav/` (clients that follow `/.well-known/carddav` find it alone) |
| Username | the full email address |
| Password | the mailbox password, the same one IMAP uses |

:::note Contacts, not calendars.
Corsair does not serve CalDAV. That is a decision rather than a gap still to be
filled: contacts are what makes autocomplete work and what people expect to
follow them between devices, while calendars are a large, quirky protocol for a
mail server to take on. Use a dedicated calendar server alongside it.
:::

## Setting up a client

### iPhone and iPad

**Settings → Contacts → Accounts → Add Account → Other → Add CardDAV Account.**

- **Server**: `mail.example.com`
- **User Name**: you@example.com
- **Password**: your mailbox password

iOS finds the address book through `/.well-known/carddav`. If it reports it
cannot connect, open **Advanced Settings** and confirm **Use SSL** is on and the
port is 443.

### macOS Contacts

**Contacts → Settings → Accounts → +** (or **System Settings → Internet
Accounts → Add Other Account**) **→ CardDAV account**. Choose **Manual** as the
account type and enter the same three values as on iOS.

### Thunderbird

If the domain publishes `autoconfig`, Thunderbird offers the address book when
you add the mail account — the autoconfig document names it.

By hand: **Address Book → New Address Book → Add CardDAV Address Book**. Enter
your email address as the username and `https://mail.example.com/dav/` as the
location. Thunderbird discovers the book and asks for the mailbox password.

### Android (DAVx⁵)

Install DAVx⁵, then **+ → Login with URL and user name**:

- **Base URL**: `https://mail.example.com/dav/`
- **User name**: you@example.com
- **Password**: your mailbox password

DAVx⁵ walks from there to the address book and syncs it into the system
contacts.

## What is supported

- **Discovery**: `/.well-known/carddav` redirects to `/dav/`;
  `current-user-principal`, `addressbook-home-set`, and the CalendarServer
  `email-address-set` are answered so clients that only know a hostname get the
  rest of the way.
- **PROPFIND** at depth 0 and 1 on the principal, the home set, the book, and each
  card, including `getctag` and `sync-token`.
- **REPORT**: `addressbook-multiget`, `addressbook-query` (text matches on any
  property — `FN`, `EMAIL`, and the rest — or every card with no filter), and
  `sync-collection` ([RFC 6578](https://datatracker.ietf.org/doc/html/rfc6578)),
  which reports deletions as well as changes.
- **GET, PUT, DELETE** with ETags. `If-Match` and `If-None-Match: *` are honoured,
  so a client editing a stale copy gets a 412 rather than overwriting a newer one.
- vCard **3.0 and 4.0**, up to **256 KB** a card (room for a photo), with a UID
  unique within the book. Cards are stored and served back byte for byte.

## What is not

- **One book per mailbox.** Creating a second one (`MKCOL`) is refused with a 403.
  The book can be renamed (`PROPPATCH` on `displayname`); nothing else on it is
  writable.
- **No sharing** between mailboxes, and no ACLs beyond "the mailbox owns its own
  book". Another mailbox's book is a 404, exactly like one that does not exist.
- **Alias, group, and agent addresses have no address book.** Aliases and groups
  are routing entries. An agent mailbox reads mail a stranger can write, so it is
  kept away from a list that autocompletes into a person's compose.
- **Sent-to recipients are not added automatically.** The address book holds what
  you put in it.

## Webmail API

The webmail reads and writes the same address book through its own session, so a
script signed in as the mailbox can too. These routes take the webmail cookie
and are scoped to that mailbox in SQL; another mailbox's contact id is a 404.
A disabled mailbox, an alias, a group or an agent mailbox has no address book
and gets a 403.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/mail/contacts` | Search. `q` (at most 200 characters) and `limit` (1 to 500, default 20) |
| POST | `/api/mail/contacts` | Create. 201 |
| PATCH | `/api/mail/contacts/:contact_id` | Replace the name and addresses |
| DELETE | `/api/mail/contacts/:contact_id` | Delete; sync clients are told it went |

The body for create and patch is `name` (1 to 200 characters) and `emails` (up to
20 addresses). A contact is `{ object: "contact", id, name, emails, updated_at }`.
`PATCH` is conditional on the stored card: if a phone rewrote it in the meantime
the answer is a 409 rather than a silent overwrite.

## Authentication

HTTP Basic, checked by the same code as IMAP, POP3, SMTP, and JMAP: failed
attempts count towards the same per-IP ban, and a mailbox that is disabled or
whose account is terminated cannot sign in here either.

A browser session cookie is never accepted on `/dav/`. If it were, any site you
visited could write to your address book through your browser. A browser on
another site that tries a PUT or DELETE is refused before authentication.

## DNS for discovery from the address alone

Clients that start from `you@example.com` look for the CardDAV server under
`example.com` ([RFC 6764](https://datatracker.ietf.org/doc/html/rfc6764)). If
`example.com` is not served by Corsair, publish an SRV record pointing at it:

```
_carddavs._tcp.example.com.  3600 IN SRV 0 1 443 mail.example.com.
_carddavs._tcp.example.com.  3600 IN TXT "path=/dav/"
```

Optional. Without it, entering the server hostname works on every client above.
