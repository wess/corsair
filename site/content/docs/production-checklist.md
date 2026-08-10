---
title: Production checklist
description: What to verify before you point a real domain at a Corsair install, and how to check each one.
section: operate
order: 5
short: Go-live checklist
eyebrow: Install and operate
---

# Production checklist

Work down this before you publish an MX record that real people depend on. Each
item has a command that either passes or does not — nothing here relies on
believing the configuration is right.

## Host

- [ ] **Static IP.** Not a dynamic or residential address. Those are on the Policy
  Block List by construction and no configuration fixes it.

- [ ] **PTR matches, both directions.**
  ```sh
  dig +short mail.example.com          # → 203.0.113.9
  dig +short -x 203.0.113.9            # → mail.example.com.
  ```

- [ ] **Outbound port 25 open.**
  ```sh
  nc -zv gmail-smtp-in.l.google.com 25
  ```
  If it hangs, set `DELIVERY_TRANSPORT=relay` and point at a smarthost.

- [ ] **Inbound port 25 reachable.** From somewhere else:
  ```sh
  nc -zv mail.example.com 25
  ```

- [ ] **IP not on a blocklist.**
  ```sh
  dig +short 9.113.0.203.zen.spamhaus.org     # reversed octets; no answer = clean
  ```

- [ ] **Clock synchronised.** DKIM signatures, webhook timestamps, and TOTP all
  depend on it.
  ```sh
  timedatectl status | grep -i synchronized
  ```

## Configuration

- [ ] **`JWT_SECRET` changed** from the default and generated randomly. Anyone who
  knows it can mint a session for any account.

- [ ] **`DELIVERY_TRANSPORT` is not `console`.** The default delivers nothing.
  ```sh
  grep DELIVERY_TRANSPORT .env
  ```

- [ ] **`SIGNUPS=closed`** unless you intend to host mail for strangers.

- [ ] **`TRUSTED_PROXIES` set** if anything sits in front of the HTTP port.
  Without it every request looks like `127.0.0.1` and the rate limiter treats the
  internet as one client.

- [ ] **`PUBLIC_URL` is the real HTTPS URL.** It goes into password reset and
  verification emails.

- [ ] **Ports are the real ones** — 25, 587, 465, 143, 993, 110, 995 — and the
  binary can bind them.
  ```sh
  sudo ss -lntp | grep bun
  ```

- [ ] **`.env` is mode 600** and owned by the service user. It holds the database
  password, the JWT secret, and your storage keys.

## TLS

- [ ] **Certificate valid for `CORSAIR_HOSTNAME`**, chain complete.
  ```sh
  openssl s_client -connect mail.example.com:993 -servername mail.example.com </dev/null 2>&1 \
    | grep -i 'verify return code'
  ```
  `0 (ok)` or it is not done.

- [ ] **Renewal automated *and* the reload hook installed.** Renewal without a
  restart is the failure mode of almost every mail server on the internet.
  ```sh
  sudo certbot renew --dry-run
  ls /etc/letsencrypt/renewal-hooks/deploy/
  ```

- [ ] **Panel behind HTTPS.** Corsair serves plain HTTP; terminate in front.

## Database

- [ ] **Migrations applied.**
  ```sh
  bun scripts/migrate.ts status     # every row "applied"
  bun scripts/migrate.ts diff       # "schema in sync"
  ```

- [ ] **Not using the default password.** `postgres://corsair:corsair@…` is the
  development default.

- [ ] **Postgres not listening on a public interface** unless you meant it.
  ```sh
  sudo ss -lntp | grep 5432
  ```

## Storage

- [ ] **Bucket configured** if you expect any volume. Without one, bodies go
  through the WAL.

- [ ] **Bucket is private.** Objects are written with no ACL and inherit the
  bucket default. Check it, especially on a bucket you already use for something
  else.
  ```sh
  curl -sI "https://BUCKET.REGION.digitaloceanspaces.com/corsair/..." | head -1
  ```
  A `403` is correct. A `200` means your mail is public.

## DNS, per domain

- [ ] **Domain shows active** in the panel.
- [ ] **SPF** published and includes `MAIL_SPF_HOST`.
- [ ] **DKIM CNAME** published for the **active** selector.
- [ ] **DMARC** published, starting at `p=quarantine`.
- [ ] **MX** points here — and this is the cutover, so do it last.

```sh
dig +short TXT example.com
dig +short TXT _dmarc.example.com
dig +short CNAME corsair-1._domainkey.example.com
dig +short MX example.com
```

## A real round trip

The only test that matters. Send to an address at a large provider and read the
headers of what arrives:

```
Authentication-Results: mx.google.com;
       spf=pass ...
       dkim=pass header.i=@example.com header.s=corsair-1
       dmarc=pass (p=QUARANTINE ...)
```

Three passes. Then send *to* the domain from outside and confirm it lands.

- [ ] Outbound: `spf=pass`, `dkim=pass`, `dmarc=pass`
- [ ] Inbound: arrives, and the `Authentication-Results` header Corsair stamped
  shows what it made of the sender
- [ ] A client connects over IMAP 993 and SMTP 587

## Operations

- [ ] **Backups running**, encrypted, and **restored at least once**. See the
  [restore drill](tutorials/backup-drill.html). A backup you have never restored
  is a file you hope about.

- [ ] **Backup failures alert.** A cron that never ran sends no failure mail
  either — alert on the absence of success.

- [ ] **Monitoring** on: the process, the queue depth, certificate expiry, disk,
  and the bounce rate. See [Monitoring](monitoring.html).

- [ ] **Log retention** decided. Mail logs contain sender and recipient addresses.

- [ ] **Service restarts on boot.**
  ```sh
  systemctl is-enabled corsair
  ```

- [ ] **You know how to read the queue** before you need to at 3am.

## Security

- [ ] **Two-factor on the owner account.** It controls every domain.
- [ ] **Firewall** allows only 25, 465, 587, 143, 993, 110, 995, 443, and SSH.
- [ ] **SSH keys only**, password authentication off.
- [ ] **`WEBHOOK_ALLOW_PRIVATE` left `false`** unless consumers really are on the
  same private network.
- [ ] **Rate limits reviewed.** `RATE_LIMIT_PER_SECOND` defaults to 10.

See [Security model](security.html) for what Corsair defends against and what it
does not.

## Deliverability

- [ ] **Volume ramped, not dumped.** A new IP sending a thousand messages on day
  one looks exactly like a compromised host.
- [ ] **MTA-STS in `testing` mode** to start. Going straight to `enforce` with a
  wrong MX list silently blackholes inbound mail.
- [ ] **A plan for bounces.** Treat a `5xx` as permanent and stop sending there.

[Deliverability](deliverability.html) covers the reputation side.

## The last one

- [ ] **Someone other than you can find the runbook.** Where the backups are, how
  to restart it, and who to call about the IP. Self-hosted mail has a bus factor
  of one by default.
