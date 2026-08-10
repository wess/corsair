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
sudo setcap 'cap_net_bind_service=+ep' "$(which bun)"
sudo systemctl restart corsair
```

:::warning Re-apply setcap after every Bun upgrade
`bun upgrade` replaces the binary, and file capabilities do not survive that.
The symptom is a service that starts and then fails to bind port 25 — easy to
miss, because the HTTP tier on 3000 comes up fine.
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
