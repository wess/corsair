---
title: TLS certificates
description: Getting a certificate, wiring it in, renewing it, and why Corsair refuses to authenticate without one.
section: operate
order: 4
short: TLS
eyebrow: Install and operate
---

# TLS certificates

Corsair refuses SMTP `AUTH` and IMAP `LOGIN` on an unencrypted connection when a
certificate is configured. It advertises `LOGINDISABLED` instead, so a client
fails at connect rather than after sending the password in the clear.

That is deliberate and it is not configurable. A password crossing the network in
plaintext is worse than no service.

## What you need

One certificate for `CORSAIR_HOSTNAME`. If clients connect to different names —
`imap.example.com`, `smtp.example.com` — either include those as subject
alternative names or point them at `CORSAIR_HOSTNAME` with CNAMEs and let clients
follow.

```sh
TLS_CERT_PATH=/etc/corsair/certs/fullchain.pem
TLS_KEY_PATH=/etc/corsair/certs/privkey.pem
```

Both are PEM. `fullchain.pem` must be the **full chain**, not just the leaf — a
leaf-only certificate validates in a browser that already has the intermediate
cached, and fails against a mail server that does not.

## Getting one from Let's Encrypt

### DNS-01, the least painful route

DNS-01 does not need port 80 open and issues wildcards, which matters if you are
serving several hostnames off one install.

```sh
sudo apt install -y certbot python3-certbot-dns-cloudflare

sudo certbot certonly \
  --dns-cloudflare \
  --dns-cloudflare-credentials /etc/letsencrypt/cloudflare.ini \
  -d mail.example.com \
  -d '*.mail.example.com'
```

```ini
# /etc/letsencrypt/cloudflare.ini — chmod 600
dns_cloudflare_api_token = your-scoped-token
```

Scope the token to **Zone → DNS → Edit** for that zone only. It lives on disk
permanently, unlike the token you paste into Corsair's DNS publish screen, which
is used once and discarded.

### HTTP-01, if port 80 is free

```sh
sudo certbot certonly --standalone -d mail.example.com
```

Simpler, but it needs port 80 reachable at renewal time and cannot issue
wildcards.

### Behind an existing reverse proxy

If nginx or Caddy already terminates TLS for the panel, point Corsair at the same
files. Caddy stores them under its data directory:

```
/var/lib/caddy/.local/share/caddy/certificates/acme-v02.api.letsencrypt.org-directory/mail.example.com/
```

Copy or symlink, and make sure the `corsair` user can read them.

## Permissions

Let's Encrypt writes `privkey.pem` root-owned and mode 600. Corsair does not run
as root, so it cannot read it.

```sh
sudo mkdir -p /etc/corsair/certs
sudo cp /etc/letsencrypt/live/mail.example.com/{fullchain,privkey}.pem /etc/corsair/certs/
sudo chown corsair:corsair /etc/corsair/certs/*.pem
sudo chmod 640 /etc/corsair/certs/privkey.pem
```

Copying rather than symlinking is deliberate: a symlink into
`/etc/letsencrypt/live` still lands on a root-only file, and `ProtectSystem` in
the unit blocks the path anyway.

## Renewal

Certificates last ninety days. Renewal is not the hard part; **reloading** is —
Corsair reads the files at startup and holds them.

```sh
# /etc/letsencrypt/renewal-hooks/deploy/corsair.sh — chmod +x
#!/usr/bin/env sh
set -eu

install -o corsair -g corsair -m 644 \
  /etc/letsencrypt/live/mail.example.com/fullchain.pem /etc/corsair/certs/fullchain.pem
install -o corsair -g corsair -m 640 \
  /etc/letsencrypt/live/mail.example.com/privkey.pem /etc/corsair/certs/privkey.pem

systemctl restart corsair
```

Certbot runs deploy hooks only when a certificate actually renewed, so this
restarts roughly every sixty days rather than twice a day.

Test the whole path before you depend on it:

```sh
sudo certbot renew --dry-run
```

:::warning Restarting drops connections
A restart disconnects every IMAP IDLE session and every in-flight SMTP
transaction. Clients reconnect and senders retry, so the cost is small — but
schedule it away from your busiest hour, and consider a
[split deployment](installation.html) if even that is too much.
:::

### Docker

With `./certs` bind-mounted, the hook writes to the host path and restarts the
container:

```sh
#!/usr/bin/env sh
set -eu
cp /etc/letsencrypt/live/mail.example.com/{fullchain,privkey}.pem /opt/corsair/certs/
docker compose -f /opt/corsair/compose.yaml restart corsair
```

## Checking what is actually served

```sh
# Implicit TLS
openssl s_client -connect mail.example.com:993 -servername mail.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates -ext subjectAltName

# STARTTLS on submission
openssl s_client -starttls smtp -connect mail.example.com:587 -servername mail.example.com </dev/null 2>/dev/null \
  | openssl x509 -noout -subject -dates
```

Check that the subject matches what clients connect to, that the dates are
current, and that the chain is complete:

```sh
echo | openssl s_client -connect mail.example.com:993 2>&1 | grep -i 'verify\|chain'
```

`Verify return code: 0 (ok)` is what you want. `unable to get local issuer
certificate` means the chain is incomplete — you gave it the leaf, not
`fullchain.pem`.

## Which ports use which

| Port | Protocol | TLS | Usable |
| --- | --- | --- | --- |
| 25 | SMTP (MX) | none — plaintext | Yes, for server-to-server delivery |
| 465 | Submission | Implicit, from the first byte | **Yes** |
| 993 | IMAP | Implicit | **Yes** |
| 995 | POP3 | Implicit | **Yes** |
| 587 | Submission | — | No: cannot authenticate |
| 143 | IMAP | — | No: cannot authenticate |
| 110 | POP3 | — | No: cannot authenticate |

:::danger STARTTLS is unavailable
Bun cannot upgrade an accepted socket to TLS, so Corsair has no server-side
STARTTLS on any protocol. It deliberately does not advertise it: a peer that
takes up the offer has already committed and cannot fall back, so advertising a
broken STARTTLS turns "delivered in plaintext" into "not delivered at all".

Because Corsair also refuses a credential over an unencrypted connection, the
three STARTTLS ports cannot be used to log in. **Configure clients for 465, 993,
and 995.**

Port 25 is unaffected in practice — senders that would have used STARTTLS simply
deliver in plaintext, which is what opportunistic means.
:::

## Self-signed, for local testing only

`test:mailflow` needs a certificate because Corsair refuses authentication
without one:

```sh
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/privkey.pem -out certs/fullchain.pem \
  -subj "/CN=mail.corsair.local"

TLS_CERT_PATH=certs/fullchain.pem TLS_KEY_PATH=certs/privkey.pem bun run test:mailflow
```

Real clients will refuse a self-signed certificate, and they are right to.

## When it goes wrong

| Symptom | Cause |
| --- | --- |
| `LOGINDISABLED` in the IMAP greeting | Working as designed on a plaintext port. Use 993, or STARTTLS first |
| Client: "certificate not trusted" | Self-signed, or the chain is incomplete |
| Client: "name does not match" | Certificate is for a different host than the client dialled |
| Corsair starts but TLS ports do not listen | Paths wrong, or the `corsair` user cannot read the key |
| Worked, then stopped after ~90 days | Renewal ran; the restart did not. Add the deploy hook |

The last one is the common one. Renewal without a reload is the failure mode of
almost every mail server on the internet.
