---
title: Configuration
description: Every environment variable Corsair reads, its default, and what changes when you set it.
section: operate
order: 2
eyebrow: Install and operate
---

# Configuration

Everything is configured through environment variables, read once at startup from
the process environment or `.env`. There is no configuration file and no
settings table — a mail server's behaviour should be reproducible from its
deployment, not from a row somebody edited.

Defaults below are what the shipped code uses, not suggestions.

## Core

| Variable | Default | What it does |
| --- | --- | --- |
| `DATABASE_URL` | `postgres://corsair:corsair@localhost:55433/corsair` | PostgreSQL connection string |
| `DB_POOL_SIZE` | `10` | Connections in the pool |
| `JWT_SECRET` | `corsair-dev-secret-change-me` | Signs session tokens. **Change this** |
| `PORT` | `3000` | HTTP listener |
| `PUBLIC_URL` | `http://localhost:3000` | Base URL in emails and redirects |
| `SIGNUPS` | `open` | `open` lets anyone sign up; `closed` allows only the first account |
| `TRUSTED_PROXIES` | *(empty)* | Proxies whose `X-Forwarded-For` is believed |

:::danger JWT_SECRET
Anyone who knows it can mint a session for any account. Generate 48 random bytes
and treat it as a credential:

`openssl rand -base64 48`

Changing it invalidates every existing session, which is also how you revoke
everything at once.
:::

`TRUSTED_PROXIES` matters more than it looks. Behind a reverse proxy with it
unset, every request appears to come from `127.0.0.1`: the rate limiter sees one
client, and the ban list bans your own proxy.

## Mail identity

| Variable | Default | What it does |
| --- | --- | --- |
| `CORSAIR_HOSTNAME` | `mail.corsair.local` | The name this server gives in EHLO and stamps into `Received` headers |

This must resolve to the IP you send from, and that IP must reverse-resolve back
to it. Without that, the large providers reject on connect.

The next group is what the DNS Setup screen tells customers to point records at —
the public names of *this* installation, not of the customer's domain. On a
single-host install, point them all at the same name.

| Variable | Default |
| --- | --- |
| `MAIL_MX_HOST` | `mx1.corsair.local` |
| `MAIL_SMTP_HOST` | `smtp.corsair.local` |
| `MAIL_IMAP_HOST` | `imap.corsair.local` |
| `MAIL_POP_HOST` | `pop.corsair.local` |
| `MAIL_SPF_HOST` | `spf.corsair.local` |
| `MAIL_AUTOCONFIG_HOST` | `autoconfig.corsair.local` |
| `MAIL_AUTODISCOVER_HOST` | `autodiscover.corsair.local` |
| `MAIL_DKIM_HOSTS` | `dkim-1.corsair.local,dkim-2.corsair.local,dkim-3.corsair.local` |

`MAIL_DKIM_HOSTS` is a comma-separated list of three. Customers publish a CNAME
per selector pointing at these names and this server answers the lookup — three
selectors let a key be rotated without a gap in signing.

## Listeners

| Variable | Default (dev) | Production |
| --- | --- | --- |
| `SMTP_MX_PORT` | `2525` | `25` |
| `SMTP_SUBMISSION_PORT` | `2587` | `587` |
| `SMTP_SUBMISSION_TLS_PORT` | `2465` | `465` |
| `IMAP_PORT` | `2143` | `143` |
| `IMAP_TLS_PORT` | `2993` | `993` |
| `POP3_PORT` | `2110` | `110` |
| `POP3_TLS_PORT` | `2995` | `995` |
| `SMTP_ENABLED` | `true` | |
| `IMAP_ENABLED` | `true` | |
| `POP3_ENABLED` | `true` | |

The defaults are unprivileged so development needs no root. Ports below 1024 need
`CAP_NET_BIND_SERVICE` — granted in the systemd unit with `AmbientCapabilities`,
or with `setcap` on the binary when running outside a service manager. See
[Installation](installation.html); the two are not interchangeable.

The `*_ENABLED` flags accept `true`, `1`, or `yes`. Turning listeners off is how
you [split the deployment](installation.html).

## TLS

| Variable | Default | What it does |
| --- | --- | --- |
| `TLS_CERT_PATH` | *(empty)* | PEM certificate chain |
| `TLS_KEY_PATH` | *(empty)* | PEM private key |

Used by the implicit-TLS listeners and by STARTTLS. Leave them empty to run
plaintext-only, which is fine locally and unacceptable anywhere else — Corsair
advertises `LOGINDISABLED` and refuses SMTP `AUTH` and IMAP `LOGIN` on an
unencrypted connection when a certificate is configured.

See [TLS certificates](tls.html).

## Delivery

| Variable | Default | What it does |
| --- | --- | --- |
| `DELIVERY_TRANSPORT` | `console` | `direct`, `relay`, or `console` |
| `SMTP_RELAY_HOST` | *(empty)* | Smarthost, for `relay` |
| `SMTP_RELAY_PORT` | `587` | |
| `SMTP_RELAY_USER` | *(empty)* | |
| `SMTP_RELAY_PASS` | *(empty)* | |
| `SMTP_RELAY_SECURE` | `starttls` | |

| Transport | Behaviour |
| --- | --- |
| `direct` | Look up the recipient's MX and talk to it. Needs port 25 outbound |
| `relay` | Hand everything to an upstream smarthost |
| `console` | Print to stdout, deliver nothing. The default, for local development |

:::warning `console` is the default
A fresh `.env` delivers nothing. That is right for a laptop and wrong for a
server — set `DELIVERY_TRANSPORT=direct` (or `relay`) as part of going live, or
mail silently goes to the log.
:::

## Storage

| Variable | Default | What it does |
| --- | --- | --- |
| `STORAGE_BUCKET` | *(empty)* | S3-compatible bucket. Empty keeps bodies in Postgres |
| `STORAGE_REGION` | `nyc3` | |
| `STORAGE_ENDPOINT` | *(empty)* | e.g. `https://nyc3.digitaloceanspaces.com` |
| `STORAGE_ACCESS_KEY_ID` | *(empty)* | |
| `STORAGE_SECRET_ACCESS_KEY` | *(empty)* | |
| `STORAGE_PREFIX` | `corsair` | Key prefix inside the bucket |

Objects are written with no ACL and inherit the bucket's default. Check that
default is private before pointing Corsair at a bucket you already use.

## Workers

| Variable | Default | What it does |
| --- | --- | --- |
| `WORKER_CONCURRENCY` | `8` | Jobs processed at once |
| `WORKER_POLL_MS` | `1000` | How often the queue is polled when idle |

The queue claims work with `FOR UPDATE SKIP LOCKED`, so any number of worker
processes can drain it without coordinating and without delivering anything
twice. Raise concurrency before adding processes.

## Payments

| Variable | Default | What it does |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | *(empty)* | Enables hosted checkout |
| `STRIPE_WEBHOOK_SECRET` | *(empty)* | Verifies settlement webhooks |

Leave both empty and Corsair runs unmetered: plans still gate features and an
operator can record payment methods by hand, but nothing is charged. That is the
right default for hosting mail for yourself.

Card details never reach this server. The customer enters them on the provider's
hosted page; a brand, four digits, and an opaque reference come back. There is no
code path here that could accept a card number.

## Webhooks

| Variable | Default | What it does |
| --- | --- | --- |
| `WEBHOOK_ALLOW_PRIVATE` | `false` | Allow endpoints on private, loopback, and link-local addresses |

The customer supplies the URL and this server fetches it, which is a server-side
request forgery primitive. `assertDeliverable` refuses private ranges by default.
Turn it on only when your consumers are genuinely on the same private network.

## Limits

| Variable | Default | What it does |
| --- | --- | --- |
| `RATE_LIMIT_PER_SECOND` | `10` | API requests per second, per principal |
| `MAX_MESSAGE_BYTES` | `52428800` | 50 MB. Advertised in the SMTP `SIZE` extension |

Authenticated requests are limited per user; unauthenticated ones per IP. Sign-in
and sign-up have their own tighter limit of **5 per second per IP**, since there
is no principal yet.

A 429 carries `retry-after`, `ratelimit-limit`, `ratelimit-remaining`, and
`ratelimit-reset`.

`MAX_MESSAGE_BYTES` is the wire size after encoding. Base64 costs about a third,
so 50 MB on the wire is roughly a 35 MB attachment.

## Seeding

| Variable | Default | What it does |
| --- | --- | --- |
| `SEED_PASSWORD` | `corsair-dev-password` | Password for the account `scripts/seed.ts` creates |

Read only by the seed script. Set it on any host that is not your laptop.

## A production starting point

```sh
DATABASE_URL=postgres://corsair:LONG_PASSWORD@localhost:5432/corsair
JWT_SECRET=<openssl rand -base64 48>
PUBLIC_URL=https://mail.example.com
SIGNUPS=closed
TRUSTED_PROXIES=127.0.0.1

CORSAIR_HOSTNAME=mail.example.com
MAIL_MX_HOST=mail.example.com
MAIL_SMTP_HOST=mail.example.com
MAIL_IMAP_HOST=mail.example.com
MAIL_POP_HOST=mail.example.com
MAIL_SPF_HOST=mail.example.com
MAIL_AUTOCONFIG_HOST=mail.example.com
MAIL_AUTODISCOVER_HOST=mail.example.com
MAIL_DKIM_HOSTS=dkim-1.mail.example.com,dkim-2.mail.example.com,dkim-3.mail.example.com

SMTP_MX_PORT=25
SMTP_SUBMISSION_PORT=587
SMTP_SUBMISSION_TLS_PORT=465
IMAP_PORT=143
IMAP_TLS_PORT=993
POP3_PORT=110
POP3_TLS_PORT=995

TLS_CERT_PATH=/etc/corsair/certs/fullchain.pem
TLS_KEY_PATH=/etc/corsair/certs/privkey.pem

DELIVERY_TRANSPORT=direct

STORAGE_BUCKET=my-mail-bucket
STORAGE_REGION=nyc3
STORAGE_ENDPOINT=https://nyc3.digitaloceanspaces.com
STORAGE_ACCESS_KEY_ID=...
STORAGE_SECRET_ACCESS_KEY=...
```

Then walk [the production checklist](production-checklist.html).

## Changing configuration

Every value is read at startup. Restart after any edit:

```sh
sudo systemctl restart corsair
# or
docker compose up -d
```

There is no reload signal. A mail server that reconfigures itself mid-connection
is a source of bugs nobody enjoys.
