---
title: Backups and restore
description: What has to survive, how to capture it, and how to bring it back without breaking IMAP clients.
section: operate
order: 6
short: Backups
eyebrow: Install and operate
---

# Backups and restore

Five things have to survive. Losing any one makes a restore incomplete, and the
ones people forget are not the database.

| Thing | Where it lives | Lose it and… |
| --- | --- | --- |
| PostgreSQL | The database | Everything: mailboxes, folders, flags, users, domains |
| Message bodies | The bucket, or Postgres if none | The mail itself |
| DKIM private keys | In the database | Signing breaks; every domain needs new keys published |
| `.env` | The host filesystem | `JWT_SECRET` is gone, every session dies, config is guesswork |
| TLS certificate | The host filesystem | Reissuable, but not instantly |

DKIM keys living in the database is why the database dump is not optional and why
it must be treated as secret material.

:::danger A database dump is a credential store
It contains DKIM private keys, password hashes, and encrypted transfer
credentials. Encrypt it at rest, and never put it in a bucket whose default is
public.
:::

## The database

```sh
pg_dump --format=custom --no-owner "$DATABASE_URL" > corsair-$(date +%F).dump
```

`--format=custom` compresses and allows selective restore. `--no-owner` means the
dump restores cleanly into a database with a different role name.

Verify rather than assume:

```sh
pg_restore --list corsair-2026-08-10.dump | head -30
```

An empty or truncated dump lists nothing. Check the size too — a zero-byte file
is the classic silent backup failure.

### How often

Continuously, if the mail matters. Nightly at minimum.

Anything between the last dump and a failure is gone: messages received,
messages sent, flag changes, new mailboxes. For a household, nightly is fine. For
a business, set up WAL archiving and point-in-time recovery — that is a Postgres
topic, not a Corsair one, and Postgres documents it well.

## Message bodies

With `STORAGE_BUCKET` set, bodies are in the bucket and **are not in the database
dump**. This is the part that gets missed: the dump restores, the counts match,
and every message opens empty.

```sh
aws s3 sync "s3://$STORAGE_BUCKET/$STORAGE_PREFIX" /backup/bodies \
  --endpoint-url "$STORAGE_ENDPOINT"
```

Or rely on the provider's versioning and lifecycle rules — but know which you are
doing, and test that you can retrieve a deleted object.

Without a bucket, bodies are inline in Postgres and the dump has everything.

## Configuration

```sh
cp /opt/corsair/app/.env ./corsair-env-$(date +%F)
age -r "$BACKUP_RECIPIENT" -o corsair-env-$(date +%F).age corsair-env-$(date +%F)
shred -u corsair-env-$(date +%F)
```

`.env` holds `JWT_SECRET`, the database password, and the storage keys. Encrypt
it. A backup of your secrets in plaintext is a breach waiting for a misconfigured
bucket.

## Certificates

Reissuable from Let's Encrypt in minutes, so back them up for speed rather than
necessity. If you use DNS-01, back up the API credentials file too — that one is
not reissuable without console access to the DNS provider.

## A nightly script

```sh
#!/usr/bin/env sh
# /usr/local/bin/corsair-backup
set -eu

STAMP=$(date +%F)
DEST=/backup

pg_dump --format=custom --no-owner "$DATABASE_URL" > "$DEST/corsair-$STAMP.dump"
age -r "$BACKUP_RECIPIENT" -o "$DEST/corsair-$STAMP.dump.age" "$DEST/corsair-$STAMP.dump"
rm "$DEST/corsair-$STAMP.dump"

# Fail loudly rather than keeping a zero-byte file that looks like a backup.
test -s "$DEST/corsair-$STAMP.dump.age"

find "$DEST" -name 'corsair-*.dump.age' -mtime +30 -delete
```

```
15 3 * * * /usr/local/bin/corsair-backup || echo "corsair backup FAILED" | mail -s "backup" you@example.com
```

:::warning Alert on the absence of success, not only on failure
A cron job that never ran sends no failure mail either. Have the script touch a
heartbeat file or ping a dead-man's-switch, and alert when that goes quiet.
:::

## Restoring

Order matters: configuration, then database, then migrations, then bodies.

### 1. Configuration first

```sh
age -d -o /opt/corsair/app/.env /backup/corsair-env-2026-08-10.age
chown corsair:corsair /opt/corsair/app/.env
chmod 600 /opt/corsair/app/.env
```

The restore needs `DATABASE_URL` and the storage keys, and a mismatched
`JWT_SECRET` is a confusing thing to debug later.

### 2. Database

```sh
sudo -u postgres createdb -O corsair corsair
pg_restore --no-owner --dbname "$DATABASE_URL" /backup/corsair-2026-08-10.dump
```

### 3. Migrations

If the backup predates a version upgrade:

```sh
bun scripts/migrate.ts status
bun scripts/migrate.ts up
bun scripts/migrate.ts diff     # "schema in sync"
```

### 4. Bodies

```sh
aws s3 sync /backup/bodies "s3://$STORAGE_BUCKET/$STORAGE_PREFIX" \
  --endpoint-url "$STORAGE_ENDPOINT"
```

### 5. Start and verify

```sh
sudo systemctl start corsair
psql "$DATABASE_URL" -Atc "SELECT count(*) FROM messages"
```

Then check the things a count cannot: **open a message** (proves the bodies came
back), **send one and check for `dkim=pass`** (proves the DKIM keys came back),
and **sign into the panel** (proves `JWT_SECRET` and the users table came back
together).

## What a restore breaks

**Every session is invalid.** Sessions are rows; old cookies point at rows that no
longer exist. Everyone signs in again. Expected.

**UIDs may go backwards.** This is the one with teeth.

:::danger Restoring an older dump onto a live folder
`uid_next` comes back to its value at dump time. New messages then reuse UIDs
that clients have already seen against different messages — and a duplicate UID
is the one thing an IMAP client never recovers from.

After restoring anything other than the newest dump, tell clients on affected
mailboxes to remove and re-add the account so they resynchronise from scratch.
:::

**In-flight outbound mail is gone** if it was queued after the dump. Senders whose
messages were accepted but not yet delivered will not know. There is no way
around this short of continuous archiving.

## Migrating to a new host

A restore onto a different machine, with two extra steps:

1. Restore normally onto the new host.
2. Update `CORSAIR_HOSTNAME` and the `MAIL_*` hosts if the names changed.
3. **Set the PTR on the new IP** and wait for it to propagate.
4. Update the A record, then the MX. Lower the TTLs a day beforehand.
5. Keep the old host accepting mail until the old MX TTL has fully expired.

The old host receiving a few messages after cutover is normal. Run a final
`pg_dump` from it and reconcile, or leave it running for a week — the second is
easier and safer.

## Testing it

A backup you have never restored is not a backup. The
[restore drill](tutorials/backup-drill.html) walks through destroying an install
and bringing it back, and tells you what to measure.

Do it twice a year and after any upgrade that touched migrations.
