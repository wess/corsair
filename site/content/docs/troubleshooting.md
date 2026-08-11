---
title: Troubleshooting
description: Symptom first — find what you are seeing, then the cause and the fix.
section: operate
order: 10
eyebrow: Install and operate
---

# Troubleshooting

Organised by what you are seeing, not by what is broken. Find the symptom, work
down the causes in order — they are ordered by how often they turn out to be it.

## First, three commands

```sh
systemctl status corsair
journalctl -u corsair --since "30 minutes ago" | grep -i error
psql "$DATABASE_URL" -c "SELECT status, count(*) FROM deliveries GROUP BY status"
```

Running, no errors, queue draining. If all three are fine, the problem is
probably DNS or the network, not Corsair.

## No mail arrives at all

**1. Is the MX record right?**

```sh
dig +short MX example.com
```

It must point at a name that resolves to this server. A missing or stale MX is
the cause more often than everything else combined.

**2. Is port 25 reachable from outside?**

```sh
# From another machine
nc -zv mail.example.com 25
```

Test from off the host. A firewall or security group blocking inbound 25 is
invisible from inside.

**3. Is the listener up?**

```sh
sudo ss -lntp | grep ':25 '
```

Nothing there means `SMTP_ENABLED=false`, or the process could not bind the
port. Check the log for `EACCES`:

```sh
journalctl -u corsair -n 40 | grep -A3 EACCES
```

`errno: 13` on port 25 while port 3000 came up fine is a capability problem. The
unit needs:

```ini
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

**A `setcap` on the Bun binary will not work here.** `NoNewPrivileges=true`
blocks file capabilities, so the grant silently has no effect. This is also the
failure after a `bun upgrade` on a `setcap`-based setup, since the replacement
binary carries no capability.

**4. Is the domain added?** Corsair only accepts mail for domains it hosts.
Everything else is refused, correctly.

**5. Watch a live delivery.**

```sh
journalctl -u corsair -f
```

Then send yourself something. If nothing appears in the log, it never arrived —
the problem is DNS or the network.

## Mail arrives but the recipient does not see it

**Check where it was filed.** The spam scorer may have put it in Junk.

```sql
SELECT m.subject, m.spam_score, f.name
FROM messages m JOIN folders f ON f.id = m.folder_id
WHERE m.address_id = (SELECT id FROM addresses WHERE address = 'you@example.com')
ORDER BY m.created_at DESC LIMIT 10;
```

**Check the filter.** A `fileinto` cancels the implicit keep, so a rule that
matched more than intended silently files mail somewhere else. A `discard` drops
it entirely.

**Check it is not sub-addressing.** `you+tag@` lands in `you@`, which is by design
but surprises people looking for a separate mailbox.

## Cannot send

**1. Is the domain active?** Corsair accepts mail for a pending domain but refuses
to send from it. Sending before SPF and DKIM are published damages the IP's
reputation for every other domain on the server.

Panel → Domains → the domain must say active. If it does not, press **Check
DNS** and read what it says is missing.

**2. Is `DELIVERY_TRANSPORT` set?**

```sh
grep DELIVERY_TRANSPORT .env
```

The default is `console` — it prints to stdout and delivers nothing. Right for a
laptop, wrong for a server.

**3. Is port 25 open outbound?**

```sh
nc -zv gmail-smtp-in.l.google.com 25
```

Hanging means blocked. Set `DELIVERY_TRANSPORT=relay` and point at a smarthost.

**4. Is the daily limit reached?** Plans cap `daily_out`. A quota error in the
response is this.

## Mail is sent but rejected by the receiver

Read the reply. It is recorded verbatim:

```sql
SELECT rcpt_to, last_code, last_error, attempts
FROM deliveries
WHERE status <> 'sent'
ORDER BY updated_at DESC LIMIT 20;
```

| Reply | Meaning | Fix |
| --- | --- | --- |
| `550 5.7.26` | No aligned SPF or DKIM | DNS is wrong or incomplete. Entirely fixable |
| `550 5.7.1` … PTR | Reverse DNS mismatch | Set the PTR at your host |
| `421 4.7.0` | Rate limited | Back off. Not a configuration error |
| `450 4.2.0` | Greylisting | Normal on a first attempt. The retry is accepted |
| `554` … blocked | IP reputation or a blocklist | Check listings; request delisting |

[SMTP error lookup](smtp-errors.html) has the full table.

## `dkim=fail` at the receiver

```sh
dig +short CNAME corsair-1._domainkey.example.com
```

**Nothing returned** — the record is not published. The panel's DNS tab has it.

**Returned, but still failing** — you may be publishing the CNAME for a selector
that is not the active one. Domains → Keys shows which is active.

**Was working, now failing** — a DNS edit for an unrelated reason removed it, or
the provider "helpfully" flattened the CNAME.

Check what the receiver saw:

```
dkim=pass header.i=@example.com header.s=corsair-1
```

`header.s` is the selector. That is the CNAME that must exist.

## `spf=fail`

```sh
dig +short TXT example.com | grep spf1
```

**Includes your host?** It must include whatever `MAIL_SPF_HOST` is set to.

**Sending from the right IP?** SPF authorises addresses. If outbound leaves
through a different interface or a NAT, that address must be listed.

**Two `v=spf1` records?** That is a permanent error and SPF stops working
entirely. There must be exactly one.

**Over ten lookups?** SPF has a hard limit of ten DNS-querying mechanisms. Every
`include:` counts, including the ones nested inside them.

## Clients cannot connect or log in

**"Certificate not trusted"** — self-signed, or the chain is incomplete. You need
`fullchain.pem`, not the leaf.

**"Server does not support authentication"** — you are on 587, 143, or 110.
Corsair has no server-side STARTTLS (Bun cannot upgrade an accepted socket), so
those ports can never become encrypted, and Corsair will not take a credential in
the clear. **Use 465, 993, or 995.** See [TLS](tls.html).

**"Wrong password"** — for your own address, use your **account password**; the
panel shows "signs in with your account password" on any mailbox that is linked.
For anyone else's mailbox it is that mailbox's own password. Alias and group
addresses have no password at all; they cannot be signed into.

**Username** is always the **full email address**. A bare local part is ambiguous
across the domains on the server.

**Check what is actually served:**

```sh
openssl s_client -connect mail.example.com:993 -servername mail.example.com </dev/null 2>&1 \
  | grep -i 'verify return code'
```

## It worked, then stopped after about ninety days

The certificate expired. Renewal ran; the reload did not — Corsair reads the
files at startup and holds them.

```sh
openssl s_client -connect mail.example.com:993 </dev/null 2>/dev/null \
  | openssl x509 -noout -enddate
```

Check the **port**, not the file on disk. Add a certbot deploy hook that restarts
the service; [TLS](tls.html) has one.

## The queue is growing

```sql
SELECT status, count(*), min(created_at) FROM deliveries GROUP BY status;
```

**One domain dominating** the failure list is a reputation problem with that
provider.

**Every domain failing** means outbound is broken — port 25, DNS resolution, or
`DELIVERY_TRANSPORT`.

**Nothing being claimed at all** means the worker is not running. It is part of
`src/start.ts`; if you run `src/server.ts` alone, nothing drains the queue.

## Webhooks stopped arriving

```sql
SELECT url, status, consecutive_failures, disabled_reason, last_success_at
FROM webhooks WHERE status <> 'active';
```

Twenty consecutive failures disables an endpoint automatically. Fix it, re-enable
it in the panel.

If deliveries are arriving but failing verification, you are almost certainly
parsing the JSON and re-serialising before checking the signature. Sign over the
raw bytes exactly as received.

## The panel is slow

**Rate limited?** A 429 carries `retry-after`. The default is 10 requests per
second per principal.

**Behind a proxy without `TRUSTED_PROXIES`?** Every request looks like
`127.0.0.1`, so the limiter treats the whole internet as one client and everyone
shares one bucket.

**Database?**

```sql
SELECT count(*), state FROM pg_stat_activity GROUP BY state;
```

All connections active means `DB_POOL_SIZE` is the constraint.

## A domain will not verify

The DNS tab shows what was actually observed, which is usually enough. The
recurring causes:

- The provider appended the domain to a host that was already fully qualified —
  `_dmarc.example.com.example.com`
- A quoted value stored **with** the quotes
- Two `v=spf1` records
- The record is right but has not propagated — a record can take up to the
  previous record's TTL to become visible

The worker re-checks pending domains every half hour on its own, so a record that
appears later is picked up without you doing anything.

## Migrations will not run

```sh
bun scripts/migrate.ts status
```

**"pending" that never applies** — read the error. Hand-written SQL that conflicts
with existing data needs fixing in the migration, not retrying.

**`diff` reports drift after a successful `up`** — a table is missing from
`allSchemas`, or a migration did not do what its schema change implies.

Never restart into a state where `diff` is not clean.

## Getting more detail

```sh
NODE_ENV=development bun src/start.ts
```

Development mode relaxes the security-header hardening and logs more. Do not
leave a production server in it.

For a single SMTP transaction, talk to the server yourself:

```sh
openssl s_client -starttls smtp -connect mail.example.com:587 -crlf
```

Every reply, in order, with no client in the way.

## Still stuck

Collect these before asking:

```sh
bun --version
git rev-parse --short HEAD
bun scripts/migrate.ts status | tail -5
systemctl status corsair --no-pager | head -20
journalctl -u corsair --since "1 hour ago" | grep -i error | tail -20
```

Then open an issue at
[github.com/wess/corsair/issues](https://github.com/wess/corsair/issues). Redact
the addresses; keep the reply codes, which are the useful part.
