---
title: Installation
description: Docker Compose, bare metal with systemd, and a split deployment — plus what each entrypoint does.
section: operate
order: 1
eyebrow: Install and operate
---

# Installation

Three ways to run Corsair. All of them need the same four things from the host —
see [Prerequisites](prerequisites.html) — and all of them run the same code.

## Entrypoints

```sh
bun src/dev.ts       # everything, with a summary of where it is listening
bun src/start.ts     # everything, quietly — this is what the container runs
bun src/server.ts    # the HTTP tier only, for a split deployment
```

```sh
bun scripts/migrate.ts up | down | status | diff
bun scripts/seed.ts
```

Migrations deliberately do not run on startup. Two instances coming up at once
would race on the migration table, and this is the one step worth being able to
run — and fail — on its own.

## Docker Compose

The shipped `compose.yaml` is the whole stack: Postgres, a one-shot migration
container, and Corsair with the real ports mapped.

```sh
git clone https://github.com/wess/corsair
cd corsair
cp .env.example .env
```

Edit `.env` for production values ([Configuration](configuration.html)), then:

```sh
export POSTGRES_PASSWORD='pick-something-long'
mkdir -p certs   # fullchain.pem and privkey.pem go here
docker compose up -d
```

The compose file overrides the ports to the real ones and mounts `./certs`
read-only at `/certs`:

```yaml
environment:
  SMTP_MX_PORT: 25
  SMTP_SUBMISSION_PORT: 587
  SMTP_SUBMISSION_TLS_PORT: 465
  IMAP_PORT: 143
  IMAP_TLS_PORT: 993
  POP3_PORT: 110
  POP3_TLS_PORT: 995
  TLS_CERT_PATH: /certs/fullchain.pem
  TLS_KEY_PATH: /certs/privkey.pem
volumes:
  - ./certs:/certs:ro
```

The `migrate` service runs `scripts/migrate.ts up` once and exits; `corsair`
waits for it with `service_completed_successfully`, so a fresh stack comes up in
the right order without a race.

Seed the first account:

```sh
docker compose run --rm corsair bun scripts/seed.ts
```

### The image

The `Dockerfile` builds on `oven/bun:1.3-alpine`, installs `libcap`, grants
`cap_net_bind_service` to the Bun binary, then drops to an unprivileged
`corsair` user. Ports below 1024 bind without the process being root.

```sh
docker compose logs -f corsair
docker compose restart corsair
```

:::warning Mount certificates, do not bake them in
`./certs` is a bind mount so renewal on the host is picked up by restarting the
container. A certificate copied into the image expires inside it.
:::

## Bare metal with systemd

The route with the fewest moving parts, and what
[the first-server tutorial](tutorials/first-server.html) walks through in full.

```sh
sudo adduser --system --group --home /opt/corsair corsair
sudo -u corsair git clone https://github.com/wess/corsair /opt/corsair/app
cd /opt/corsair/app
sudo -u corsair bun install
sudo -u corsair cp .env.example .env
```

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

# Ports below 1024, granted to the service rather than to the binary.
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
```

:::danger Under systemd, use AmbientCapabilities — not `setcap`
`NoNewPrivileges=true` **blocks file capabilities outright**. A
`setcap cap_net_bind_service=+ep` on the Bun binary silently does nothing under
this unit, and the service fails with `EACCES` on port 25 while the HTTP tier on
3000 comes up fine — which makes it look like a mail-specific problem rather
than a permissions one.

`AmbientCapabilities` is the correct mechanism and is strictly better anyway: it
survives `bun upgrade` replacing the binary, and nothing on disk carries a
capability.

Use `setcap` only when running Corsair **outside** systemd — by hand, or under a
supervisor that does not set `NoNewPrivileges`.
:::

## Split deployment

The HTTP tier and the mail listeners can run as separate processes against the
same database.

```sh
bun src/server.ts                  # HTTP only: API, panel, webmail, JMAP
SMTP_ENABLED=true IMAP_ENABLED=false POP3_ENABLED=false bun src/start.ts
```

Reasons to bother:

- **Restart the panel without dropping IMAP sessions.** A deploy of the web tier
  no longer disconnects every mail client.
- **Different machines.** The HTTP tier behind a load balancer, the mail
  listeners on the host that owns the reputable IP.
- **Scale the worker separately.** Several instances can drain the delivery queue;
  it claims work with `FOR UPDATE SKIP LOCKED`, so they do not coordinate and
  cannot deliver anything twice.

The listener toggles are `SMTP_ENABLED`, `IMAP_ENABLED`, and `POP3_ENABLED`.

## Reverse proxy

Corsair serves plain HTTP on `PORT` (default 3000). Terminate TLS in front of it.

```nginx
server {
  listen 443 ssl http2;
  server_name mail.example.com;

  ssl_certificate     /etc/letsencrypt/live/mail.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/mail.example.com/privkey.pem;

  # JMAP blob upload and webmail attachments.
  client_max_body_size 60m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Then set `TRUSTED_PROXIES` or every request appears to come from `127.0.0.1` and
the rate limiter treats the entire internet as one client:

```sh
TRUSTED_PROXIES=127.0.0.1
```

:::danger Never proxy the mail ports
SMTP, IMAP, and POP3 must reach Corsair directly. Putting an HTTP proxy in front
of them does not work, and putting a TCP proxy in front without PROXY protocol
support hides the client IP — which SPF, the rate limiter, and the ban list all
depend on.
:::

## Object storage

Set the bucket and message bodies go to object storage, with only headers and
flags in Postgres.

```sh
STORAGE_BUCKET=my-mail-bucket
STORAGE_REGION=nyc3
STORAGE_ENDPOINT=https://nyc3.digitaloceanspaces.com
STORAGE_ACCESS_KEY_ID=...
STORAGE_SECRET_ACCESS_KEY=...
STORAGE_PREFIX=corsair
```

Leave `STORAGE_BUCKET` empty and bodies stay inline in Postgres. That works and
keeps a single-container install to one dependency, but it puts mail volume
through the WAL. Configure a bucket for anything real.

Objects are written with **no ACL**, so they inherit the bucket's default of
private. Mail must never be publicly readable — check the bucket's default before
pointing Corsair at it.

## Verifying the install

```sh
sudo ss -lntp | grep bun          # every enabled listener
curl -s localhost:3000/api/plans  # the API answers
bun scripts/migrate.ts status     # every migration applied
bun scripts/migrate.ts diff       # "schema in sync"
```

Then open `/app`, sign in with the seeded account, and add a domain.

## Upgrading

See [Upgrading](upgrading.html). The short version: pull, install, run
migrations, restart — and read the migration list before you do.
