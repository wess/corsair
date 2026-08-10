---
title: Your first production server
description: Take a blank VPS to delivered, authenticated mail — host, DNS, TLS, domain, mailbox, and a verified round trip.
section: tutorials
order: 2
short: First server
eyebrow: Tutorial
---

# Your first production server

A blank VPS to real mail, in about an hour of work plus DNS propagation. At the
end you will have a domain whose mail arrives at your own machine, sends with a
valid DKIM signature, and passes a receiver's DMARC check.

## Before you start

Work through [Prerequisites](../prerequisites.html) first and have these in hand:

- A VPS with a **static IP** and **outbound port 25** confirmed open
- A **hostname** you control, e.g. `mail.example.com`
- **DNS control** for the domain whose mail you are hosting
- Root or sudo on the host

Throughout: `example.com` is the domain whose mail you are hosting, and
`mail.example.com` is the server.

## 1. Point the hostname at the box

Publish an A record for the server itself, then set the PTR in your hosting
provider's control panel. Both directions must agree.

```sh
$ dig +short mail.example.com
203.0.113.9
$ dig +short -x 203.0.113.9
mail.example.com.
```

:::danger Do not continue until these match
A mismatched PTR is rejected on connect by every large provider. Nothing later in
this tutorial can compensate for it, and you will spend the afternoon debugging
the wrong layer.
:::

## 2. Install the runtime and the database

```sh
sudo apt update && sudo apt install -y unzip postgresql-17 git
curl -fsSL https://bun.sh/install | bash
```

Create the database and a role for it:

```sh
sudo -u postgres psql <<'SQL'
CREATE ROLE corsair LOGIN PASSWORD 'pick-something-long';
CREATE DATABASE corsair OWNER corsair;
SQL
```

If you would rather run Postgres in a container, the shipped
`compose.yaml` does the whole stack — see [Installation](../installation.html).

## 3. Get Corsair

```sh
sudo adduser --system --group --home /opt/corsair corsair
sudo -u corsair git clone https://github.com/wess/corsair /opt/corsair/app
cd /opt/corsair/app
sudo -u corsair ~/.bun/bin/bun install
```

## 4. Get a certificate

Corsair refuses SMTP `AUTH` and IMAP `LOGIN` without TLS, so this comes before
the first start. DNS-01 avoids needing port 80 open:

```sh
sudo apt install -y certbot
sudo certbot certonly --standalone -d mail.example.com
```

```sh
sudo mkdir -p /etc/corsair/certs
sudo cp /etc/letsencrypt/live/mail.example.com/{fullchain,privkey}.pem /etc/corsair/certs/
sudo chown -R corsair:corsair /etc/corsair/certs
```

[TLS certificates](../tls.html) covers renewal, which you will want automated
before the ninety days are up.

## 5. Configure

```sh
sudo -u corsair cp .env.example .env
sudo -u corsair ${EDITOR:-nano} .env
```

The settings that matter for a first server:

```sh
DATABASE_URL=postgres://corsair:pick-something-long@localhost:5432/corsair
JWT_SECRET=<64 random characters>
PUBLIC_URL=https://mail.example.com

CORSAIR_HOSTNAME=mail.example.com

# These are the public names of *this* installation, quoted back to you on the
# DNS Setup screen. Point them all at this host.
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
SIGNUPS=closed
```

Generate the secret properly — it signs every session:

```sh
openssl rand -base64 48
```

:::warning SIGNUPS=closed
Leave signups open only if you intend to run mail for strangers. On a personal
server, `closed` means the first account — yours — is the only one that can be
created.
:::

Every setting is listed in [Configuration](../configuration.html).

## 6. Decide how it binds the privileged ports

Ports below 1024 need a capability. Under systemd — which is what step 8 sets up —
that is granted in the unit with `AmbientCapabilities`, so there is nothing to do
here.

:::danger Do not use `setcap` under systemd
`NoNewPrivileges=true` blocks file capabilities. A
`setcap cap_net_bind_service=+ep` on the Bun binary silently does nothing, and
the service dies with `EACCES` on port 25 while the HTTP tier on 3000 starts
normally — which sends you looking at the mail code instead of the unit file.

Use `setcap` only when running Corsair outside systemd.
:::

## 7. Migrate and seed

```sh
sudo -u corsair ~/.bun/bin/bun scripts/migrate.ts up
sudo -u corsair SEED_PASSWORD='something-long' ~/.bun/bin/bun scripts/seed.ts
```

Migrations are deliberately not run on startup — two instances coming up at once
would race, and this is the step worth being able to run and fail on its own.

## 8. Run it as a service

```ini
# /etc/systemd/system/corsair.service
[Unit]
Description=Corsair mail server
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=corsair
Group=corsair
WorkingDirectory=/opt/corsair/app
ExecStart=/opt/corsair/.bun/bin/bun src/start.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production

# Ports below 1024. This is what makes 25/465/587/143/993/110/995 bindable by
# an unprivileged user, and it survives `bun upgrade` replacing the binary.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/opt/corsair/app

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now corsair
sudo systemctl status corsair
```

Check every listener came up:

```sh
sudo ss -lntp | grep bun
```

You should see 25, 465, 587, 143, 993, 110, 995, and 3000.

## 9. Put the panel behind HTTPS

Corsair serves plain HTTP on 3000. Terminate TLS in front of it:

```nginx
server {
  listen 443 ssl http2;
  server_name mail.example.com;

  ssl_certificate     /etc/letsencrypt/live/mail.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/mail.example.com/privkey.pem;

  # JMAP blob upload and large attachments.
  client_max_body_size 60m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then tell Corsair which proxy to believe, or every request will appear to come
from `127.0.0.1` and the rate limiter will treat the whole internet as one
client:

```sh
TRUSTED_PROXIES=127.0.0.1
```

Restart, and open `https://mail.example.com/app`.

## 10. Add the domain

Sign in with the seeded credentials. **Domains → New domain →** `example.com`.

Corsair generates a verification token, three DKIM key pairs, and the full
record set, then shows you the DNS Setup tab.

## 11. Publish the records

If `example.com`'s DNS is at Cloudflare or DigitalOcean, use **Publish
automatically**, paste an API token, and Corsair writes all of them. The token is
used once and discarded — it is never stored, because a DNS token can usually
rewrite every record on every domain in the account.

Otherwise, copy them or export the zone file. The set is:

| Type | Host | Purpose |
| --- | --- | --- |
| TXT | `@` | Ownership verification |
| TXT | `@` | SPF |
| TXT | `_dmarc` | DMARC policy |
| CNAME | `corsair-1._domainkey` | DKIM key 1 |
| CNAME | `corsair-2._domainkey` | DKIM key 2 (rotation spare) |
| CNAME | `corsair-3._domainkey` | DKIM key 3 (rotation spare) |
| CNAME | `mta-sts` | MTA-STS policy host |
| CNAME | `autoconfig` | Thunderbird setup |
| CNAME | `autodiscover` | Outlook setup |
| MX | `@` | Where your mail is delivered |

[DNS setup](../dns-setup.html) explains each one and what breaks without it.

:::warning The MX record is the cutover
Publishing the MX is the moment mail starts arriving here instead of wherever it
went before. If you are migrating an existing domain, do the
[transfer](migrate-from-google.html) first and leave the MX until last.
:::

## 12. Check DNS

Press **Check DNS**. Once the required records resolve, the domain flips to
**active** and sending is unlocked. If a record does not match, the panel shows
what it actually observed — usually a provider that appended the domain to a host
that was already fully qualified, or a value stored with its quotes.

Propagation is real: a record can take up to the previous record's TTL to become
visible. The worker also re-checks pending domains every half hour on its own.

## 13. Create a mailbox

**Domains → example.com → New mailbox.** Local part `you`, and a password.

That password is the **mailbox** credential. It is not your control-panel
password, and it never will be — see [Core concepts](../concepts.html).

## 14. Prove it works

**Receive.** Send a message to `you@example.com` from an outside account. Then
open `https://mail.example.com/webmail` and sign in with the mailbox address and
password. It should be there.

**Send.** Configure a client, or use the webmail, and send to an address you can
read at a large provider. Then check the headers on what arrives:

```
Authentication-Results: mx.google.com;
       spf=pass (google.com: domain of you@example.com designates 203.0.113.9 ...)
       dkim=pass header.i=@example.com header.s=corsair-1
       dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE)
```

Three passes. That is the goal, and it is the thing to re-check any time
deliverability goes strange.

**Connect a client.** Full email address as the username, mailbox password, and:

| Protocol | Host | Port | Security |
| --- | --- | --- | --- |
| IMAP | `mail.example.com` | 993 | SSL/TLS |
| SMTP | `mail.example.com` | 465 | SSL/TLS |

## 15. Before you call it done

- [ ] **Backups configured** — [Backups and restore](../backups.html), then
  actually [run the drill](backup-drill.html)
- [ ] **Certificate renewal automated** — [TLS](../tls.html)
- [ ] **Object storage** if you expect volume — [Configuration](../configuration.html)
- [ ] **Monitoring** on the queue and the certificate — [Monitoring](../monitoring.html)
- [ ] **The production checklist** — [read it through](../production-checklist.html)

## If mail does not flow

| Symptom | Look at |
| --- | --- |
| Nothing arrives | MX record published? Port 25 open *inbound*? `journalctl -u corsair` |
| You cannot send | Is the domain active? Port 25 open *outbound*? |
| `dkim=fail` at the receiver | DKIM CNAME published for the **active** selector |
| `spf=fail` | SPF record includes `MAIL_SPF_HOST`, and you are sending from the right IP |
| Client refuses to log in | Certificate valid for the hostname the client is using |

[Troubleshooting](../troubleshooting.html) goes symptom by symptom.
