---
title: Getting started
---

# Getting started

## Locally, in five minutes

```sh
git clone https://github.com/wess/corsair
cd corsair
bun install
cp .env.example .env
bun run db:up
bun run migrate
bun run seed
bun run dev
```

`seed` prints the first account's credentials. That account owns the instance.
Open `http://localhost:3000/app`.

The development ports are unprivileged so none of this needs root: SMTP on
2525 / 2587 / 2465, IMAP on 2143 / 2993, POP3 on 2110 / 2995.

## Before it is reachable mail

Four things decide whether mail actually flows, and none of them are code.

### 1. A static IP with a matching PTR record

`CORSAIR_HOSTNAME` must resolve to the IP you send from, and that IP must
reverse-resolve back to it. Set the PTR through your hosting provider's control
panel — it is not something you can put in your own DNS. Without it the large
providers reject on connect, before they have seen a single message.

### 2. Port 25 outbound

Most cloud providers block it. Ask them to unblock it, or set
`DELIVERY_TRANSPORT=relay` and hand outbound mail to a smarthost.

### 3. TLS

```
TLS_CERT_PATH=/etc/letsencrypt/live/mail.example.com/fullchain.pem
TLS_KEY_PATH=/etc/letsencrypt/live/mail.example.com/privkey.pem
```

Corsair refuses SMTP AUTH and IMAP LOGIN without a certificate. That is
deliberate: a password crossing the network in the clear is worse than no
service, and discovering it here is better than discovering it afterwards.

### 4. Binding the privileged ports

```sh
setcap 'cap_net_bind_service=+ep' "$(which bun)"
```

Then set the ports to 25, 465, 587, 993, and 995. The alternative is running the
mail server as root, which it should not be.

## Your first domain

1. **Domains → New domain.** Corsair generates a verification token, three DKIM
   key pairs, and the full record set.
2. **Publish the records.** The DNS Setup tab lists every one with a copy
   button, and can export a zone file.
3. **Check DNS.** Once the required records resolve, the domain flips to active
   and sending is unlocked. Corsair also re-checks a pending domain every half
   hour, because people publish records and never come back to press the button.
4. **Create a mailbox.** Domains → your domain → New mailbox.
5. **Connect a client** with the settings on the Client Configuration tab.

Until a domain is active, Corsair *accepts* mail for it but refuses to *send*
from it — sending before SPF and DKIM are published damages the IP's reputation
for every other domain on the server.
