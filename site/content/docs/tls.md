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

## Built-in ACME (optional)

For an install with **no reverse proxy and no certbot** — one box, Corsair on its
own — Corsair can obtain and renew the mail listeners' certificate itself over
ACME (RFC 8555). If you already run certbot or Caddy, keep doing that and leave
this off: it is off by default and nothing about the paths above changes.

```sh
ACME=on
ACME_EMAIL=postmaster@example.com      # the CA writes here about expiry
ACME_AGREE_TOS=true                    # you have read the CA's terms
ACME_DOMAINS=mail.example.com,smtp.example.com,imap.example.com
ACME_HTTP_PORT=80                      # answer the challenge on port 80
```

Corsair refuses to start with `ACME=on` unless `ACME_EMAIL` is set and
`ACME_AGREE_TOS` is literally `true`. Agreeing to a CA's terms is the
operator's decision, not a default.

With `ACME=on`, `TLS_CERT_PATH` and `TLS_KEY_PATH` are ignored.

### What it does

- **HTTP-01 only.** TLS-ALPN-01 would need Corsair to hold port 443, and DNS-01
  would need a DNS API credential kept on disk, which Corsair deliberately does
  not keep. For wildcards or a host that cannot take inbound port 80, use
  certbot with DNS-01 above.
- **Names.** `ACME_DOMAINS` defaults to `CORSAIR_HOSTNAME`. List every name
  clients dial — the `MAIL_SMTP_HOST`, `MAIL_IMAP_HOST`, `MAIL_POP_HOST`, and if
  you want them covered, the autoconfig, MTA-STS, and webmail hosts. Nothing is
  added for you: a name whose DNS does not point here fails the whole order.
  Adding a name later triggers a new certificate on the next check.
- **Storage.** `ACME_DIR` (default `./data/acme`) holds `account.key` and
  `certificate.pem` — the private key followed by the full chain, in one file so
  that replacing it is a single atomic rename. Both are mode 0600. Back the
  directory up or not; losing it costs a fresh issue, nothing more.
- **Renewal.** Checked at startup and daily after. A certificate with 30 days or
  less left is renewed. A failure is logged loudly on every attempt and retried
  after 1 h, 2 h, 4 h … up to daily; the working certificate is never removed or
  replaced by anything that has not validated.
- **No restart.** A renewed certificate is picked up in place. STARTTLS reads the
  current certificate on every upgrade. The implicit-TLS ports (465, 993, 995)
  are rebound: the old listener stops accepting, leaves its open sessions alone,
  and a new one binds the same port — so an IMAP IDLE survives a renewal.
  (Bun cannot swap the certificate on a running listener; `reload({ tls })` is
  accepted and ignored.)

### Port 80

Let's Encrypt validates HTTP-01 **on port 80**, and Corsair's HTTP tier listens on
`PORT` (3000). Either:

- set `ACME_HTTP_PORT=80`. Corsair opens a small listener there that answers
  only `/.well-known/acme-challenge/` and redirects everything else to
  `https://`. Under systemd the unit's `CAP_NET_BIND_SERVICE` already covers it;
  in Docker publish `80:80` and set `ACME_HTTP_PORT=80`; or
- forward port 80 to `PORT` yourself (a NAT rule). The same path is served on
  `PORT` through the normal request path.

Only tokens for an order in flight are served; any other token is a 404.

### First start

With no certificate yet, Corsair starts without one — the panel, and port 25
unencrypted, as on any install without a certificate — and requests one
straight away. When it arrives, 465, 993, and 995 open and the
[STARTTLS probe](#which-ports-use-which) runs again, so nothing needs restarting.
If issuance fails, the log says why and it retries on the backoff above.

Test against the staging CA first. Its certificates are not trusted, but its rate
limits are generous and a mistake costs nothing:

```sh
ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory
```

Delete `ACME_DIR/certificate.pem` before switching to production, or the staging
certificate stays until it is due.

### Status and manual renewal

```sh
bun run acme status            # names, expiry, whether renewal is due
bun run acme renew [--force]   # issue now
```

`renew` answers the challenge itself on `ACME_HTTP_PORT`, so it only works when
that port is free — before the server starts, or with it stopped. A running
server renews on its own and adopts a certificate written by `renew` at its next
daily check.

### What it does not cover

- **The panel's HTTPS.** The certificate is for the mail listeners. Corsair's HTTP
  tier is plain HTTP on `PORT`; browsers still want something terminating TLS in
  front of it.
- **A split deployment.** The client runs in `start.ts`, beside the listeners it
  reloads. `server.ts` on its own ignores `ACME`.

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

:::danger If you publish TLSA records, keep the key
A `3 1 1` TLSA record pins the certificate's key, and certbot makes a new key on
every renewal by default. The first renewal then stops mail from every sender
that checks DANE. Issue and renew with `--reuse-key`, and change keys only with
both records published — see [DANE](deliverability.html#dane).
:::

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
| 587 | Submission | STARTTLS, where the runtime supports it | Only after a successful upgrade |
| 143 | IMAP | — | No: cannot authenticate |
| 110 | POP3 | — | No: cannot authenticate |

:::warning STARTTLS depends on the runtime
Corsair can only offer STARTTLS if the runtime can upgrade an already-accepted
socket to TLS. Older builds of Bun cannot, and throw at the moment of upgrade.

Corsair **probes this at startup** — it opens a loopback listener and tries —
rather than testing for a version or a function name. An earlier version checked
for an API that never shipped, which would have kept STARTTLS switched off long
after the runtime had learned to do it.

Where the probe says no, STARTTLS is not advertised on any protocol, the three
plaintext ports cannot be used to log in, and autoconfig hands clients **465,
993, and 995** instead. The MTA-STS policy publishes `mode: none` to match,
because a policy is a promise the MX has to keep.

Where it says yes, all of that flips: STARTTLS is advertised, 587/143/110 accept
a login after upgrading, autoconfig names 587, and the policy moves to `testing`.

Nothing needs configuring either way, and `bun run test:starttls:server` reports
which case you are in.
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
| `ACME RENEWAL FAILED` in the log | Port 80 does not reach Corsair, or a name in `ACME_DOMAINS` does not resolve here. The old certificate stays in service |

The last one is the common one. Renewal without a reload is the failure mode of
almost every mail server on the internet.
