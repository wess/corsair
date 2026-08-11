---
title: Quickstart
description: Get Corsair running on your own machine in about ten minutes, with nothing leaving the laptop.
section: start
order: 3
eyebrow: Start here
---

# Quickstart

Ten minutes to a running install on your own machine. Nothing here touches the
public internet: mail is printed to the console instead of delivered, the ports
are unprivileged, and no DNS is involved.

Do this before you provision a server. It is much cheaper to learn the panel on a
laptop than on a host you are also debugging.

## What you need

| Requirement | Version | Notes |
| --- | --- | --- |
| [Bun](https://bun.sh) | 1.3 or newer | The runtime. Nothing else is needed |
| Docker | Any recent | For PostgreSQL. A local Postgres 17 works too |
| Disk | — | About 500 MB including the database |

```sh
bun --version    # 1.3.x or newer
docker --version
```

## Install

```sh
git clone https://github.com/wess/corsair
cd corsair
bun install
cp .env.example .env
```

`.env.example` is already set up for local work: `DELIVERY_TRANSPORT=console`,
unprivileged ports, and no TLS. You do not need to edit anything yet.

## Start the database

```sh
bun run db:up
```

That runs PostgreSQL 17 in Docker on port **55433** — deliberately not 5432, to
stay clear of any system install you already have.

```sh
bun run migrate
```

Migrations do not run on startup. Two instances coming up at once would race on
the migration table, and this is the one step worth being able to run — and fail —
by itself.

## Seed the first account

```sh
bun run seed
```

This creates the default plan ladder and one account, then prints its
credentials:

```
plans: trial, startup, small_business, mini_tycoon

  email     admin@corsair.local
  password  corsair-dev-password
```

Set `SEED_PASSWORD` before running it if you would rather choose. The first
account created **owns the instance** — that is what `users.is_owner` records,
and there can only ever be one.

## Run it

```sh
bun run dev
```

```
[corsair] api         http://localhost:3000
[corsair] panel       http://localhost:3000/app
[corsair] webmail     http://localhost:3000/webmail
[corsair] smtp mx     :2525
[corsair] submission  :2587 / :2465
[corsair] imap        :2143 / :2993
[corsair] pop3        :2110 / :2995
```

Open <http://localhost:3000/app> and sign in with the seeded credentials.

:::note Why the odd ports
Ports below 1024 need root or `CAP_NET_BIND_SERVICE`. Development uses
2525 / 2587 / 2465, 2143 / 2993, and 2110 / 2995 so none of this needs
privileges. Production uses the real ones — see
[Installation](installation.html).
:::

## Add a domain

In the panel: **Domains → New domain**. Use anything; `example.test` is fine
locally. Corsair generates a verification token, three DKIM key pairs, and the
full record set, then shows you the DNS Setup tab.

Locally you cannot publish those records and the domain will stay pending. That
is expected. Corsair still **accepts** mail for a pending domain — it just refuses
to **send** from it, because sending before SPF and DKIM are published damages the
IP's reputation for every other domain on the server.

## Create a mailbox

**Domains → your domain → New mailbox.** Give it a local part and a password.
This password is the *mailbox* credential — it is not your control-panel
password, and the two are deliberately separate identities. A mailbox credential
ends up in a phone that gets lost; it must not also unlock the panel.

## Deliver a message to it

Corsair's MX is listening on 2525. Talk to it directly:

```sh
printf 'EHLO test\r\nMAIL FROM:<someone@elsewhere.test>\r\nRCPT TO:<you@example.test>\r\nDATA\r\nFrom: Someone <someone@elsewhere.test>\r\nTo: you@example.test\r\nSubject: First message\r\n\r\nIt works.\r\n.\r\nQUIT\r\n' | nc localhost 2525
```

You should see `250 2.0.0` after the dot. Now open
<http://localhost:3000/webmail>, sign in with the **mailbox** address and
password, and the message is there.

## Read it over IMAP

The same message, over the protocol a real client uses:

```sh
printf 'a LOGIN you@example.test yourpassword\r\nb SELECT INBOX\r\nc FETCH 1 (ENVELOPE)\r\nd LOGOUT\r\n' | nc localhost 2143
```

:::warning Plaintext login only works because there is no certificate
Corsair refuses `LOGIN` and SMTP `AUTH` over an unencrypted connection *when TLS
is configured* — it advertises `LOGINDISABLED` instead. With no certificate at
all, as here, there is nothing to upgrade to and plaintext is allowed so local
development is possible. Never run a real server without
[TLS](tls.html).
:::

## What you just proved

The full inbound path ran: the SMTP state machine accepted the message, SPF and
DKIM were evaluated, the spam scorer looked at it, the recipient was resolved,
any filter ran, and it was written to a folder — then IMAP and the webmail read
the same row.

## Where to go next

- [Core concepts](concepts.html) — the vocabulary the rest of the manual uses
- [Your first production server](tutorials/first-server.html) — the real thing,
  on a VPS, with DNS and TLS
- [Prerequisites](prerequisites.html) — read before you buy a server

## Tearing it down

```sh
bun run db:down          # stops Postgres, keeps the volume
docker volume rm corsair-pgdata   # deletes the data
```
