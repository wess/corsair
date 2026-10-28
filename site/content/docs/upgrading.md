---
title: Upgrading
description: Pull, migrate, restart — and the parts of that sequence which are not safe to do in the wrong order.
section: operate
order: 8
eyebrow: Install and operate
---

# Upgrading

The sequence is pull, install, migrate, restart. The order matters and the
migration step is the one that can hurt.

## Before you start

```sh
pg_dump --format=custom --no-owner "$DATABASE_URL" > pre-upgrade-$(date +%F).dump
```

Take it every time. Migrations are forward-only in practice — `migrate down`
rolls back exactly one migration, and only if that migration wrote a `down` — so
the dump is your actual undo.

Read what changed:

```sh
git fetch origin
git log --oneline HEAD..origin/main
git diff --stat HEAD..origin/main -- migrations/
```

A changed `migrations/` directory means schema work. Read those files before
running anything; hand-written SQL is easier to review than it is to reverse.

## The upgrade

```sh
cd /opt/corsair/app
sudo -u corsair git pull
sudo -u corsair bun install
```

Check what is pending, then apply:

```sh
sudo -u corsair bun scripts/migrate.ts status
sudo -u corsair bun scripts/migrate.ts up
```

Confirm the schema matches what the code expects:

```sh
sudo -u corsair bun scripts/migrate.ts diff
# schema in sync
```

`diff` compares the live database against `allSchemas`. Anything other than
"schema in sync" means the migration did not fully land — do not restart into
that state.

```sh
sudo systemctl restart corsair
```

Then verify:

```sh
systemctl status corsair
sudo ss -lntp | grep bun            # every listener came back
curl -sf localhost:3000/api/plans   # the API answers
```

## Upgrading to 0.4

Nothing here needs action to keep running, but read the first two items.

- **Six migrations** (`20261028000015_qresync`, `…017_dmarcreports`,
  `…019_apppasswords`, `…021_dkimrotate`, `…023_spam`, `…024_contacts`). All are
  additive and each has a `down.sql`. Run them before restarting, as always.
  After 0.4.1, `…025_storagestate` adds `users.storage_state`, which is how the
  storage warnings know they have already been sent.
- **Corsair can hold ports 25 and 587 itself.** On a runtime that passes the
  STARTTLS probe (Bun 1.4.4 or later) it upgrades connections without the Rust
  terminator in `engine/`, which is now an optional fallback. Keeping the terminator
  works unchanged. To drop it, set `SMTP_MX_PORT=25`, `SMTP_SUBMISSION_PORT=587`,
  `SMTP_BIND=0.0.0.0`, an empty `SMTP_TRUSTED_PROXIES` and
  `SMTP_STARTTLS_FRONTED=false`, stop and disable the front, and restart. Empty
  `SMTP_TRUSTED_PROXIES` matters: only list a proxy you run. See [Listeners](configuration.html#listeners) and
  [STARTTLS on 25 and 587](configuration.html#starttls-on-25-and-587).
- **0.4.1 closes connections that pipeline commands behind `STARTTLS`** on SMTP,
  IMAP, POP3 and ManageSieve, and caps the SMTP listener at 512 connections.
  A client that sends the next command before the upgrade finishes was never
  valid, but it will now be disconnected rather than served.

New features. These need no configuration to keep your install behaving as it
did, but some are on by default:

| Feature | Default | Where |
| --- | --- | --- |
| ManageSieve on port 4190 | On (`MANAGESIEVE_ENABLED`). Open the port if you want it | [Filters](filters.html#editing-from-a-mail-client) |
| IP and domain blocklists | Score only. `SPAM_DNSBL=zen.spamhaus.org`, `SPAM_URIBL=dbl.spamhaus.org`. Set `SPAM_RESOLVER` to a local resolver | [Spam filtering](spam.html#blocklists) |
| Greylisting | Off (`SPAM_GREYLIST=false`) | [Greylisting](spam.html#greylisting) |
| DMARC and TLS-RPT reports | On. Sent daily from `REPORTS_FROM`; `DMARC_REPORTS_SEND=false` and `TLSRPT_SEND=false` turn them off | [Reports Corsair sends](deliverability.html#reports-corsair-sends) |
| DANE for outbound delivery | `DANE=auto`: on only if the resolver is seen to validate DNSSEC. Set `DANE_RESOLVER` | [DANE](deliverability.html#dane) |
| Built-in ACME | Off (`ACME=on`) | [Built-in ACME](configuration.html#built-in-acme) |
| DKIM rotation | Off (`DKIM_ROTATE_DAYS=0`) | [DKIM rotation](configuration.html#dkim-rotation) |
| Metrics at `/metrics` | Off until `METRICS_TOKEN` is set | [Prometheus metrics](monitoring.html#prometheus-metrics) |
| ARC | Chains are checked and forwarded mail is sealed. `ARC_TRUSTED_SEALERS` is empty, so no DMARC override | [Forwarded mail](configuration.html#forwarded-mail-arc) |
| App passwords | Per mailbox, none until created | [App passwords](client-setup.html#app-passwords) |
| CardDAV at `/dav/` | On, with the panel's HTTPS listener | [Contacts](contacts.html) |

If you run the Rust front, no change is required. If a firewall rule allows only
the ports you used to serve, add 4190 when you want ManageSieve.

## Upgrading to 0.3

Four things in 0.3 can surprise an existing install:

:::warning Corsair will not start with a default `JWT_SECRET`
It refuses the shipped default, any value copied from the repository, and anything
shorter than 32 characters, and says so in the log. Set a real one first
(`openssl rand -base64 48`). Changing it signs everyone out, and invalidates the
SRS signatures on bounces for mail forwarded in the last few days, which is
harmless but noisy.
:::

- **Sessions are stored on the server and signed with their own keys.** Everyone
  signed in — to the panel and to webmail — signs in once more after the upgrade.
  Forwarded mail already in flight, and transfers already running, keep working:
  the old signature and encryption are still accepted for them until they age out.
- **The message size limit defaults to 25 MB** (it was 50 MB). If you set
  `MAX_MESSAGE_BYTES` yourself, nothing changes; if you relied on the default and
  want the old limit, set it, mindful that the pipeline holds several copies of a
  message and one 50 MB message once peaked near 900 MB.
- **Four migrations** (`…011` to `…014`) add agent mailboxes and webmail sessions.
  All additive; each has a `down.sql`. Run them before restarting, as always.
- **If you run the Rust STARTTLS front,** rebuild and replace it. The new one
  refuses a backend that does not accept its XCLIENT (check `127.0.0.1` is in
  `SMTP_TRUSTED_PROXIES`), and has idle, handshake and connection limits.

## Why migrations do not run at startup

Two instances coming up at once would race on the migration table. Running it
separately also means a failed migration fails *there*, visibly, rather than
inside a service that then restart-loops.

On a single-host install this is a small inconvenience. On anything with more
than one instance it is the difference between a controlled upgrade and a
corrupted schema.

## With Docker Compose

The compose file already sequences it: the `migrate` service runs once and exits,
and `corsair` waits for `service_completed_successfully`.

```sh
cd /opt/corsair
git pull
docker compose build
docker compose up -d
```

To run migrations by hand instead:

```sh
docker compose run --rm corsair bun scripts/migrate.ts up
docker compose up -d --force-recreate corsair
```

## Zero-downtime, roughly

Corsair is one process, so a restart drops connections. You can narrow the window
rather than eliminate it.

**Split the tiers.** Run `src/server.ts` for HTTP and `src/start.ts` with the
listeners for mail. Deploy the HTTP tier without touching IMAP sessions.

**Two mail hosts behind one MX.** Publish two MX records at equal priority.
Senders retry the other on a refused connection, so restarting one at a time
loses nothing — SMTP is built to retry, and this is the case it was built for.

**Accept the blip.** A restart drops IMAP IDLE sessions, which clients reconstruct
within seconds, and in-flight SMTP transactions, which senders retry for days.
For most installs this is the right answer.

:::note What a restart actually costs
Queued outbound mail is safe — it is rows in `deliveries`, not memory. IMAP
clients reconnect. SMTP senders retry. The visible cost is a few seconds where
new connections are refused.
:::

## Rolling back

**Application only**, no migration involved:

```sh
git checkout <previous-tag>
bun install
sudo systemctl restart corsair
```

**After a migration** — restore the dump. A newer schema with older code is not a
supported combination, and rolling the schema back by hand while mail is arriving
is not a good afternoon.

```sh
sudo systemctl stop corsair
sudo -u postgres dropdb corsair
sudo -u postgres createdb -O corsair corsair
pg_restore --no-owner --dbname "$DATABASE_URL" pre-upgrade-2026-08-10.dump
git checkout <previous-tag>
sudo systemctl start corsair
```

Everything that happened between the dump and the rollback is lost — messages
received, messages sent, flags changed. That is why the dump is taken
immediately before the upgrade and not that morning.

## Upgrading PostgreSQL

Corsair targets PostgreSQL 17. A major version upgrade is a Postgres operation:

```sh
pg_dump --format=custom --no-owner "$DATABASE_URL" > full.dump
# install the new major version, create the cluster
pg_restore --no-owner --dbname "postgres://…/corsair" full.dump
```

Stop Corsair first. A dump taken while mail is arriving is a dump of a moving
target, and the one thing you cannot tolerate is a folder whose `uid_next` is
older than its messages.

## Upgrading Bun

```sh
bun upgrade
sudo systemctl restart corsair
```

:::note Nothing to re-grant, if you are on systemd
`bun upgrade` replaces the binary, and file capabilities do not survive that —
so a `setcap`-based setup breaks on every upgrade, with the service failing to
bind port 25 while the HTTP tier on 3000 comes up fine.

The unit in [Installation](installation.html) uses `AmbientCapabilities`, which
is granted to the service rather than the file and is therefore unaffected. If
you inherited a `setcap` setup, this is a good moment to switch.
:::

## After any upgrade

- [ ] Send a message out, check for `dkim=pass`
- [ ] Receive one from outside
- [ ] Connect a client over IMAP
- [ ] `bun scripts/migrate.ts diff` reports in sync
- [ ] The queue is draining
- [ ] Nothing new in `journalctl -u corsair --since "10 minutes ago" | grep -i error`

Then delete the pre-upgrade dump — or keep it for a week, which is cheaper than
regretting it.
