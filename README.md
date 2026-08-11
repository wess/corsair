# Corsair

Open source email hosting. Mailboxes on your own domains — SMTP, IMAP, POP3,
and a control panel — in one Bun process backed by PostgreSQL and S3-compatible
object storage.

Corsair is a self-hostable alternative to a hosted mail provider. It is the mail
server *and* the panel: you add a domain, publish the DNS records it gives you,
create mailboxes, and point any mail client at it.

**[Documentation](https://wess.github.io/corsair/docs/)** —
[quickstart](https://wess.github.io/corsair/docs/quickstart.html) (ten minutes on
your laptop),
[your first production server](https://wess.github.io/corsair/docs/tutorials/first-server.html)
(an hour, on a real VPS), and reference for every setting, endpoint, and
protocol.

```
corsair
├── src/
│   ├── server.ts        HTTP only
│   ├── start.ts         everything in one process
│   ├── dev.ts           local entrypoint
│   ├── schema/          every table, one module
│   ├── <feature>/       auth, domains, addresses, store, mime, dkim, spf, …
│   ├── smtp/            MX inbound, submission, outbound delivery, SRS
│   ├── imap/            IMAP4rev1
│   ├── pop3/            POP3
│   ├── worker/          DNS checks, retries, IMAP migration, retention
│   ├── api/             HTTP routes: panel, webmail, JMAP, webhooks
│   ├── web/             the control panel (React)
│   └── mail/            the webmail client (React)
├── migrations/          hand-written SQL
├── scripts/             migrate, seed
├── site/                marketing and docs
└── tests/
```

## What it does

**Receiving.** An ESMTP listener on port 25 accepts mail for hosted domains,
checks SPF, verifies DKIM, evaluates DMARC, scores it for spam, runs the
recipient's Sieve filter, and files it into an IMAP folder. Unmatched
recipients fall through to sub-addressing, then a catch-all, then a fallback
domain.

**Sending.** Authenticated submission on 587 and 465. The sender is proven to
belong to the caller, the message is signed with the domain's DKIM key, a copy
is filed in Sent, and delivery is queued with retry and backoff out to five
days. Forwarded mail is SRS-rewritten so it survives the next hop's SPF check.

**Reading.** Four ways into the same store, with no synchronisation between
them because there is only one copy of the mail:

- **IMAP4rev1** — SELECT, FETCH with partial and section addressing, SEARCH,
  SORT, STORE, COPY, MOVE, APPEND, IDLE, UIDPLUS.
- **JMAP** (RFC 8620 + 8621) — session discovery, batched method calls with
  back-references, Mailbox/Email/Thread/Identity, EmailSubmission, and blob
  upload and download.
- **POP3** — for the clients that still want it.
- **Webmail** — a three-pane client at `/webmail`, signed in with the mailbox
  credential rather than a control-panel one.

**Event hooks.** Corsair POSTs a signed JSON payload to your endpoint when mail
arrives, bounces, or is filed as spam, and when domains and mailboxes change.
Signed with the Standard Webhooks scheme, so existing verification libraries
work unchanged; retried on a widening schedule for about a day; and an endpoint
that fails twenty times in a row is disabled rather than hammered forever.

**Managing.** A control panel for domains, mailboxes (standard, alias,
catch-all, group), Sieve filters, IMAP migration from a previous host,
two-factor authentication, plans, and billing.

**DNS, without the copying.** Corsair detects the domain's provider from its NS
records and, given an API token, publishes all ten records itself —
Cloudflare and DigitalOcean today. The token is used once and never stored: a
DNS token can usually rewrite every record on every domain in an account, and
holding one to save a paste is a bad trade. Manual setup, a live checker, and a
zone-file export are always there too.

**Recovery.** Email verification and password reset for panel accounts, plus
optional per-domain self-service recovery so a mailbox owner can reset their own
password — sent to a recovery address rather than to the mailbox they cannot get
into.

**Billing, if you want it.** Plans gate storage, daily limits, and features.
With `STRIPE_SECRET_KEY` set, checkout is hosted by the provider and settled
over a signed webhook; card details never reach this server, and there is no
code path here that could accept a card number. Without it, Corsair runs
unmetered — the right default for hosting mail for yourself.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer
- PostgreSQL 17 (a `docker compose` file is included)
- Optionally an S3-compatible bucket — DigitalOcean Spaces, AWS S3, MinIO

## Local setup

```sh
bun install
cp .env.example .env
bun run db:up
bun run migrate
bun run seed
bun run site:build   # renders the docs site into site/public
bun run dev
```

The panel is at <http://localhost:3000/app>. `seed` prints the first account's
credentials; that account owns the instance.

The development ports are unprivileged on purpose: SMTP on 2525/2587/2465, IMAP
on 2143/2993, POP3 on 2110/2995. Production uses the real ones — see below.

## Running it for real

Corsair is a mail server, and the internet treats mail servers with suspicion by
default. Four things decide whether your mail is delivered or silently binned,
and none of them are code:

1. **A static IP with a matching PTR record.** `CORSAIR_HOSTNAME` must resolve
   to the IP you send from, and that IP must reverse-resolve back to it. Without
   this the large providers reject on connect.
2. **Port 25 outbound.** Most cloud providers block it by default and will
   unblock it on request. DigitalOcean and Hetzner require a support ticket; AWS
   requires a form. If you cannot get it, set `DELIVERY_TRANSPORT=relay` and
   hand outbound mail to a smarthost.
3. **TLS.** `TLS_CERT_PATH` and `TLS_KEY_PATH` must point at a real certificate
   for `CORSAIR_HOSTNAME`. Corsair refuses SMTP AUTH and IMAP LOGIN without it —
   a password in the clear is worse than no service.
4. **Binding the privileged ports.** Ports below 1024 need either root or the
   capability:

   ```sh
   setcap 'cap_net_bind_service=+ep' "$(which bun)"
   ```

   Then set the ports to 25, 465, 587, 993, and 995.

### Object storage

Set `STORAGE_BUCKET` and friends and message bodies go to the bucket, with only
headers and flags in Postgres. Leave it empty and bodies stay inline in
Postgres, which works but puts mail volume through the WAL and loses anything
still in the outbound queue across a restart. Configure a bucket for anything
real.

Objects are written with no ACL, so they inherit the bucket's default of
private. Mail must never be publicly readable.

## Entrypoints

```sh
bun src/dev.ts       # everything, with a summary of where it is listening
bun src/start.ts     # everything, quietly — this is what the container runs
bun src/server.ts    # the HTTP tier only, for a split deployment

bun scripts/migrate.ts up | down | status | diff
bun scripts/seed.ts
```

Migrations deliberately do not run on startup: two instances coming up at once
would race, and it is the one step worth being able to run — and fail — on its
own.

## Tests

```sh
bun test               # unit and integration, needs Postgres
bun run test:smoke     # API contract, needs a running server
bun run test:webmail   # webmail end to end, including the sanitiser
bun run test:jmap      # JMAP end to end, as a real client speaks it
bun run test:mailflow  # a real message over real SMTP/IMAP/POP3 sockets
bun run typecheck
bun run check          # biome
```

`bun test` covers the MIME parser, DKIM signing and verification, SPF address
math, the Sieve interpreter, SRS, the SMTP state machine, the full inbound
delivery path, IMAP against a real mailbox, and POP3. The integration suites use
a real database rather than mocks, because the failure modes that matter — a
duplicate UID, a lost expunge, a mis-routed recipient — only appear there.

`test:mailflow` is the one that proves the whole thing is wired together: it
starts every listener, delivers a message over SMTP, and reads it back over both
IMAP and POP3. It needs a certificate, since Corsair refuses authentication
without TLS:

```sh
mkdir -p certs && openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -keyout certs/privkey.pem -out certs/fullchain.pem -subj "/CN=mail.corsair.local"
TLS_CERT_PATH=certs/fullchain.pem TLS_KEY_PATH=certs/privkey.pem bun run test:mailflow
```

## Reading mail in a browser

Corsair ships its own webmail at `/webmail`. Message bodies are sanitised on the
**server** — scripts, event handlers, `javascript:` URLs, and remote images are
removed before the browser is handed anything, because every message a mail
server accepts is attacker-supplied by definition. Remote images are withheld
until the reader asks, since a remote image in an email is a tracking pixel.

If you would rather run something else, the IMAP and JMAP servers are standard:
Roundcube, SnappyMail, and any JMAP client work against them unchanged.

## Documentation

`site/` holds the manual — markdown in `site/content`, rendered to static HTML in
`site/public` by `site/build.ts`.

```sh
bun run site:build   # render content into site/public
bun run site:check   # render, then verify every internal link resolves
```

The same output is served two ways: by this server out of `site/public` for any
path that is not an API route, and by GitHub Pages via
`.github/workflows/pages.yml`. Every link the generator emits is relative to the
page carrying it, so the tree works at a domain root, under a `/corsair/`
project-page prefix, or opened off a local disk.

`SITE_MODE=pages` swaps the control-panel link for a documentation one, since
there is no `/app` behind a static host.

## License

MIT.
