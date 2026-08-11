---
title: Command line
description: Every script and entrypoint, what it does, and when to reach for it.
section: reference
order: 7
short: Command line
eyebrow: Reference
---

# Command line

Corsair has no administrative CLI. Everything an operator does is either an
entrypoint, a script, or SQL — which keeps the surface small and means nothing is
hidden behind a subcommand you have to discover.

## Entrypoints

```sh
bun src/dev.ts       # everything, with a summary of where it is listening
bun src/start.ts     # everything, quietly — this is what the container runs
bun src/server.ts    # the HTTP tier only, for a split deployment
```

`dev.ts` prints the listening summary and is meant for a terminal you are looking
at. `start.ts` is the same process without the noise. `server.ts` runs the API,
panel, webmail, and JMAP without any mail listener and without the worker.

:::warning `server.ts` does not drain the queue
The worker is part of `start.ts`. Run `server.ts` alone and outbound mail queues
forever with nothing to deliver it.
:::

## Migrations

```sh
bun scripts/migrate.ts up       # apply everything pending
bun scripts/migrate.ts down     # roll back exactly one
bun scripts/migrate.ts status   # what is applied, what is pending
bun scripts/migrate.ts diff     # compare the live schema against the code
```

Deliberately separate from the serving processes. Two instances coming up at once
would race on the migration table, and this is the one step worth being able to
run — and fail — on its own.

`diff` is the one people miss. It compares the live database against `allSchemas`
and either says `schema in sync` or writes a migration for the difference. Run it
after every `up`; anything else means the migration did not fully land, and you
should not restart into that state.

Migrations are hand-written SQL under `migrations/`. `diff` emits no indexes,
foreign keys, or unique constraints, so those are always written by hand.

## Seeding

```sh
bun scripts/seed.ts
SEED_PASSWORD='something-long' bun scripts/seed.ts
```

Creates the default plan ladder and one account, then prints its credentials. It
is idempotent: an existing plan key or an existing user is left alone.

The account it creates **owns the instance** if it is the first one.

## Package scripts

```sh
bun run dev            # src/dev.ts
bun run start          # src/start.ts
bun run api            # src/server.ts with hot reload

bun run migrate        # migrate up
bun run migrate:status
bun run migrate:down
bun run migrate:diff
bun run seed

bun run db:up          # PostgreSQL in Docker on 55433
bun run db:down

bun run site:build     # render site/content into site/public
```

## Tests

```sh
bun test               # unit and integration. Needs Postgres
bun run test:smoke     # API contract. Needs a running server
bun run test:webmail   # webmail end to end, including the sanitiser
bun run test:jmap      # JMAP end to end, as a real client speaks it
bun run test:mailflow  # a real message over real SMTP/IMAP/POP3 sockets
```

`bun test` runs with `--concurrency=1` because the integration suites share a
database.

`test:mailflow` proves the whole thing is wired together: it starts every
listener, delivers a message over SMTP, and reads it back over both IMAP and
POP3. It needs a certificate, since Corsair refuses authentication without TLS:

```sh
mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/privkey.pem -out certs/fullchain.pem -subj "/CN=mail.corsair.local"

TLS_CERT_PATH=certs/fullchain.pem TLS_KEY_PATH=certs/privkey.pem bun run test:mailflow
```

`test:smoke` backs off on 429 because the rate limiter is real.

## Code quality

```sh
bun run typecheck      # tsc --noEmit
bun run lint           # biome lint
bun run format         # biome format
bun run check          # both
bun run tidy           # format:fix then lint:fix
```

## Operational SQL

The things there is no command for.

**Queue state:**

```sql
SELECT status, count(*), min(created_at) AS oldest FROM deliveries GROUP BY status;
```

**What is failing and why:**

```sql
SELECT rcpt_to, last_code, last_error, attempts
FROM deliveries WHERE status <> 'sent'
ORDER BY updated_at DESC LIMIT 20;
```

**Storage per account:**

```sql
SELECT u.email, pg_size_pretty(sum(m.size)::bigint)
FROM messages m
JOIN addresses a ON a.id = m.address_id
JOIN domains d ON d.id = a.domain_id
JOIN users u ON u.id = d.user_id
WHERE m.expunged_at IS NULL
GROUP BY 1 ORDER BY sum(m.size) DESC;
```

**Disabled webhooks:**

```sql
SELECT url, status, consecutive_failures, disabled_reason
FROM webhooks WHERE status <> 'active';
```

**Worker jobs:**

```sql
SELECT kind, status, count(*), max(updated_at) FROM jobs GROUP BY 1, 2;
```

**Force a domain re-check** — or just press the button in the panel:

```sql
INSERT INTO jobs (kind, payload) VALUES ('domain.verify', '{}'::jsonb);
```

## Backups

No script ships with Corsair; it is `pg_dump` plus your object store's sync
command. [Backups and restore](backups.html) has a working nightly script and the
list of what actually has to survive.

## Why there is no admin CLI

Everything an operator needs is either configuration (environment variables, read
at startup), schema (migrations), or data (SQL). A CLI would be a fourth place to
look, and it would need its own authentication, its own audit trail, and its own
tests.

The panel covers what a person does regularly. SQL covers what a person does
rarely. Neither needed a wrapper.
