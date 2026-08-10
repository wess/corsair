---
title: A backup and restore drill
description: Take a backup, destroy the install, bring it back. The only way to know a backup works.
section: tutorials
order: 7
short: Restore drill
eyebrow: Tutorial
---

# A backup and restore drill

Ninety minutes, once. Take a full backup, destroy the install, and restore it
onto a clean host. A backup you have never restored is not a backup — it is a
file you hope about.

Do this on a **staging host**, not on the server currently receiving your mail.

## What actually has to survive

Losing any one of these makes the restore incomplete, and the ones people forget
are not the database.

| Thing | Where | Lose it and… |
| --- | --- | --- |
| PostgreSQL | The database | Everything. Mailboxes, folders, flags, users, domains |
| Message bodies | The bucket, or Postgres if none | The mail itself |
| DKIM private keys | In the database | Signing breaks; every domain needs new keys published |
| `.env` | The host | `JWT_SECRET` is gone, every session dies, and config is guesswork |
| TLS certificate | The host | Reissuable, but not instantly |

The DKIM keys live in the database, so a database backup covers them — which is
exactly why the database dump is not optional and why it must be treated as
secret material.

:::danger A database dump is a credential store
It contains DKIM private keys, password hashes, and encrypted transfer
credentials. Encrypt it at rest and keep it off any bucket that is
world-readable.
:::

## 1. Take the backup

### The database

```sh
pg_dump --format=custom --no-owner \
  "postgres://corsair:PASSWORD@localhost:5432/corsair" \
  > /backup/corsair-$(date +%F).dump
```

`--format=custom` compresses and lets you restore selectively. Verify it is not
empty and that it lists the tables you expect:

```sh
pg_restore --list /backup/corsair-2026-08-10.dump | head -30
```

### The configuration

```sh
cp /opt/corsair/app/.env /backup/corsair-env-$(date +%F)
```

Then encrypt it. It holds `JWT_SECRET`, the database password, and your storage
keys.

```sh
age -p -o /backup/corsair-env-$(date +%F).age /backup/corsair-env-$(date +%F)
shred -u /backup/corsair-env-$(date +%F)
```

### The message bodies

With `STORAGE_BUCKET` set, bodies are in the bucket and are not in the database
dump. Back the bucket up separately, or rely on the provider's versioning — but
know which you are doing.

```sh
aws s3 sync s3://your-bucket/corsair /backup/bodies --endpoint-url "$STORAGE_ENDPOINT"
```

Without a bucket, bodies are inline in Postgres and the dump has everything.

## 2. Note what you are about to prove

Before destroying anything, write down what must be true afterwards:

```sh
psql "$DATABASE_URL" -Atc "SELECT count(*) FROM messages"
psql "$DATABASE_URL" -Atc "SELECT count(*) FROM addresses"
psql "$DATABASE_URL" -Atc "SELECT address, uid_next FROM folders JOIN addresses ON addresses.id = folders.address_id ORDER BY 1,2 LIMIT 10"
```

Keep the output. A restore that "looks fine" is not the same as a restore whose
numbers match.

Also note one specific message you will look for by hand — a subject and a date.

## 3. Destroy it

On the staging host, genuinely destroy it. Half-measures let a leftover file
carry the restore and you learn nothing.

```sh
sudo systemctl stop corsair
sudo -u postgres dropdb corsair
sudo rm -rf /opt/corsair
```

## 4. Restore

### Rebuild the host

Install Bun, PostgreSQL, and clone the repository —
[steps 2 and 3 of the first-server tutorial](first-server.html).

### Restore the configuration first

```sh
age -d -o /opt/corsair/app/.env /backup/corsair-env-2026-08-10.age
sudo chown corsair:corsair /opt/corsair/app/.env
sudo chmod 600 /opt/corsair/app/.env
```

Configuration before database, because the restore needs `DATABASE_URL` and the
storage keys, and because a mismatched `JWT_SECRET` is a confusing failure to
debug later.

### Restore the database

```sh
sudo -u postgres createdb -O corsair corsair
pg_restore --no-owner --dbname "$DATABASE_URL" /backup/corsair-2026-08-10.dump
```

### Bring the schema up to date

If the backup predates a version upgrade, apply any migrations it is missing:

```sh
bun scripts/migrate.ts status
bun scripts/migrate.ts up
```

Then confirm the schema matches what the code expects:

```sh
bun scripts/migrate.ts diff
# schema in sync
```

### Restore the bodies

```sh
aws s3 sync /backup/bodies s3://your-bucket/corsair --endpoint-url "$STORAGE_ENDPOINT"
```

Skip if you never had a bucket.

## 5. Start it and check the numbers

```sh
sudo systemctl start corsair
```

Run the same three queries. They must match what you wrote down.

```sh
psql "$DATABASE_URL" -Atc "SELECT count(*) FROM messages"
```

:::warning `uid_next` must not go backwards
If you restore an older dump onto a folder that has since received mail, UIDs get
reissued — and a duplicate UID is the one thing an IMAP client never recovers
from. After any restore that is not the newest dump, clients on affected
mailboxes should be told to resynchronise from scratch.
:::

## 6. Check the parts a count does not cover

**Read a message.** Sign into the webmail and open the specific message you noted.
If bodies are in a bucket, this is the test that the bucket restore worked — the
count came from Postgres and proves nothing about the object store.

**Send one.** Send from a restored mailbox to an outside address and check the
headers for `dkim=pass`. That proves the DKIM private keys survived, which is the
failure people discover a week later.

**Log into the panel.** Proves `JWT_SECRET` and the users table came back
together. Every existing session is invalid after a restore — expected, since
sessions are rows and the old cookies point at rows that no longer exist.

**Connect a real client** over IMAP. Proves TLS and the folder structure.

## 7. Write down how long it took

The number you want is not "do we have backups" but "how long until mail flows
again". Time the restore from step 4 to a verified send. That figure is your real
recovery objective, and it is usually longer than people guess.

## Automating it

Once the manual drill works, script it:

```sh
#!/usr/bin/env sh
# /usr/local/bin/corsair-backup — run nightly from cron
set -eu

STAMP=$(date +%F)
DEST=/backup

pg_dump --format=custom --no-owner "$DATABASE_URL" > "$DEST/corsair-$STAMP.dump"
age -r "$BACKUP_RECIPIENT" -o "$DEST/corsair-$STAMP.dump.age" "$DEST/corsair-$STAMP.dump"
rm "$DEST/corsair-$STAMP.dump"

# Fail loudly rather than silently keeping a zero-byte file.
test -s "$DEST/corsair-$STAMP.dump.age"

find "$DEST" -name 'corsair-*.dump.age' -mtime +30 -delete
```

```
15 3 * * * /usr/local/bin/corsair-backup || echo "corsair backup FAILED" | mail -s "backup" you@example.com
```

A backup job that fails silently is worse than no backup job, because it removes
the worry without removing the risk. Alert on failure, and alert on the *absence*
of a success — a cron that never ran sends no failure mail either.

## Repeat it

Twice a year, and after any upgrade that touched migrations. It takes ninety
minutes and it is the only way the answer stays true.

[Backups and restore](../backups.html) is the reference version of this page.
