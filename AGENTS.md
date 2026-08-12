# Corsair — working notes

Self-hostable email hosting. Bun workspace, Atlas, PostgreSQL, S3. Read this
before changing anything.

## Conventions

Inherited from Atlas — see `../atlas/SOUL.md` if it is checked out beside this
repo. The layout matches `../stohr` and `../devpipe`, which is the house
pattern: a flat `src/<feature>/index.ts`, no workspaces, `@atlas/*` resolved
through tsconfig paths, and `src/server.ts` assembling the router.

- Filenames are lowercase, no dashes or underscores. Hierarchy comes from
  directories: `src/<feature>/<part>/index.ts`.
- Features import each other by relative path (`../auth/index.ts`). There is no
  barrel — a module exports what it owns and callers name it.
- Functional only. No `class`. Transforms return new objects.
- Bun APIs over `node:*` when both exist (`Bun.serve`, `Bun.listen`,
  `Bun.connect`). `node:crypto` and `node:dns/promises` have no Bun equivalent
  and are used directly.
- Imports come from `@wess/atlas/<pkg>` — Atlas is a git dependency, not a
  workspace member.

## Things that will bite you

**Everything on the wire is latin1.** `core/mime`, the SMTP session, the IMAP
session, and the storage layer all handle messages as latin1 strings, so one
character is exactly one byte. IMAP literals and `RFC822.SIZE` are octet counts;
decoding to UTF-8 anywhere in that path silently changes every offset. Decode to
real Unicode only at the point something displays text.

**Bun's Postgres driver does not bind a JS array to a Postgres array.** Pass the
array itself and expand it with `jsonb_array_elements_text`. Do **not**
`JSON.stringify` it first — that produces a jsonb *scalar* and Postgres answers
`cannot extract elements from a scalar`. See `expunge()` in `core/store`.

**`@atlas/db` has no `RETURNING *`.** `returning()` is typed over the schema's
column keys and emits nothing when given none. Use `...allColumns(schema)` from
`src/db`.

**`WhereBuilder` has no `.and()`.** Return an array of predicates from the
callback and they are ANDed. `.or()` and `.raw()` exist. Delete is `.del()`,
not `.delete()`.

**Postgres BIGINT arrives as a JS bigint**, which `JSON.stringify` refuses.
Every byte count, UID, and modseq in this schema is one. `num()` in
`src/db` converts on the way out.

**IMAP UID allocation must stay atomic.** `claimUid` does
`UPDATE folders SET uid_next = uid_next + 1 ... RETURNING`, which takes a row
lock. Two deliveries that both read `uid_next` before either writes would get
the same UID, and a duplicate UID is the one thing an IMAP client never
recovers from. There is a concurrency test for this — keep it.

**EXPUNGE is emitted highest sequence first.** IMAP renumbers after every single
EXPUNGE, so ascending order makes a client delete the wrong messages.

**Header values must be sanitised.** A bare CR or LF in a subject, display name,
or custom header injects a header. `stripControls` in `core/mime` runs on every
value this codebase emits. There are regression tests — keep them.

**`Bun.serve({ routes })` is matched before `fetch`, so anything registered
there skips every wrapper around `fetch`.** The panel and the webmail used to be
`routes` entries, which meant the two documents that execute JavaScript and
render attacker-supplied mail were the only two responses served without a CSP
or `frame-ancestors`, while the JSON API had both. They are bundled in
`src/bundle` and served through `fetch` now. `dev.ts` passes `hmr: true` to get
the `routes` path back for hot reload — opt *in* from the development
entrypoint, so `bun src/start.ts` with no NODE_ENV set is still hardened.

**STARTTLS capability is probed, never assumed.** `src/starttls` opens a
loopback listener at startup and tries the upgrade, because there is no flag to
test: `socket.upgradeTLS` is a function on every build and throws only at call
time on an accepted socket. A previous version tested for
`Bun.upgradeDuplexToTLS` — a name that appears in Bun's error message but exists
on no build — which would have kept STARTTLS off forever. Autoconfig,
autodiscover, and the MTA-STS mode are all derived from the probe's answer, and
`tests/headers.test.ts` asserts the three agree.

**Do not reuse the listener's handler object for the upgraded socket.** Bun runs
`open` on the TLS socket, and every listener's `open` builds fresh state, starts
a new session, and writes a greeting — so passing `handlers` straight through
silently replaced the connection with an unauthenticated one that still
advertised STARTTLS and no longer advertised AUTH. Pass
`{ ...handlers, open: (s) => (s.data = state) }`.

**Bun delivers the post-upgrade stream to BOTH sockets** (oven-sh/bun#26297), so
each listener's `data` drops anything arriving on the cleartext socket once
`state.tlsSocket` is set. Without that gate the session parses a TLS ClientHello
as a command and every subsequent command arrives twice. The same bug bit the
outbound client in `src/smtp/client`.

**A browser bundle needs `process.env.NODE_ENV` defined explicitly.** Nothing
infers it from the server's own environment. Without the `define` in
`src/bundle`, React ships its development build: 488 KB instead of 257 KB, prop
validation on every render, and a double render under StrictMode.

**`MAIL FROM:<>` is legal and mandatory.** RFC 5321 requires the null
reverse-path on every delivery status notification, so the empty string is a
valid sender and cannot double as "no transaction yet". `Envelope.hasSender`
answers that question; `envelope.mailFrom` answers a different one. Conflating
them made the server answer `MAIL FROM:<>` with 250 and then reject the
following RCPT with "503 Send MAIL FROM first", which meant Corsair could not
receive a bounce from anyone — including from its own queue.

**Forwarding without SRS breaks.** An alias that forwards keeps the original
envelope sender, whose SPF does not list us, and the next hop sees a forgery.
`packages/smtp/srs` rewrites it. The HMAC is not optional — without it the
rewritten address is an open relay.

**The DKIM-Signature header is hashed without its trailing CRLF** (RFC 6376
§3.7). `canonSignatureHeader` in `src/dkim` exists only to enforce that. The
signer and the verifier here both included it once, which meant they agreed with
each other and with nobody else: the round-trip test passed while every receiver
recorded `dkim=fail` on our mail and every correctly-signed message arriving
failed here. Nothing logs an error in that state — the signature is well-formed
and the key resolves. `tests/dkimwire.test.ts` rebuilds the signed input by hand
from the spec and verifies with `node:crypto` rather than with this codebase,
because a test that uses our own verifier cannot see this class of bug at all.

**One DKIM keypair per selector host, shared by every domain.**
`MAIL_DKIM_HOSTS` is installation-wide and each domain publishes
`corsair-N._domainkey` as a CNAME to it, so that one name holds one TXT record.
A keypair minted per domain cannot be expressed in that: the second domain's
public key has nowhere to go and its mail fails while looking correct on the way
out. `createDomain` adopts the pair already in use for the host. The private key
being shared changes no blast radius — one server holds all of them either way.

**A blocklisted sending IP defers; it does not bounce.** RFC 5321 says 5xx is
permanent, and for the recipient it is. A `554 ... blocked using
zen.spamhaus.org` is not about the recipient: it is a permanent-shaped answer
to a condition the operator clears with a form, so bouncing destroys mail that
would deliver an hour later and tells the sender their message failed. The rule
in `src/smtp/client` is narrow in two directions on purpose — it applies only
*before a recipient is named*, so "no such user" can never reach it, and only
when the text names a blocklist. `tests/reputation.test.ts` pins both halves;
dropping either makes two of them fail. `corsair-check` asks zen.spamhaus.org
about this server's own outbound address directly, because the resolver a
droplet is handed is one Spamhaus refuses — it answers `127.255.255.254` rather
than an error, and reading that as a listing raises an alarm that can never
clear. It reads dig's status rather than `+short`, because an empty `+short` is
either "not listed" or "never got an answer" and a monitor that cannot tell
those apart reports health for a server it failed to ask.

## One store, four protocols

SMTP, IMAP, JMAP, POP3, and the webmail all read and write the same `messages`
and `folders` rows. There is no per-protocol copy and no synchronisation step,
which is why a message delivered over SMTP is instantly visible over all of
them — and why a change to `core/store` affects every one at once.

**A move must preserve the row id.** `moveTo` in `core/store` updates
`folder_id` and allocates a fresh UID in the target while writing a tombstone in
the source. Do not implement a move as `copyTo` + `expunge`: that mints a new
id, and JMAP requires an Email's id to survive a change of mailbox. IMAP is
satisfied either way, so the bug is invisible until a JMAP client fetches the id
it just moved.

**Rendered mail is sanitised server-side** (`core/sanitize`), never in the
client. The policy is an allow-list — unknown tags and attributes are dropped
rather than inspected — because a deny-list has to stay complete as browsers
change. Remote images are withheld by default; they are tracking pixels.

## Route ordering

`@wess/atlas/server`'s router matches in registration order and does not rank
static segments above dynamic ones. `/api/filters/validate` must be registered
before `/api/filters/:filter_id`, and `addressRoutes` is registered before
`domainRoutes` so `/api/domains/:domain_id/addresses` is not swallowed.
`packages/api/index.ts` documents the intended order.

## Error handling

Route handlers are wrapped by `wrap()` in `packages/api/pipes`, which renders
thrown `HttpError`s into the `{ statusCode, name, message }` envelope. Postgres
constraint violations are translated there too — a unique violation is a 409,
not a 500.

## Auth

Two identities. They stay distinct — what is shared is at most the credential.

- A **user** is a control-panel login (session cookie). It owns domains.
- An **address** is a mailbox credential (SMTP/IMAP/POP3). It owns messages.

**A mailbox that *is* its owner's own account shares one password.**
`addresses.user_id` links them; the address stores no `password_hash` and every
protocol verifies against the account's via `mailboxHash` in `src/auth`. One
person held two credentials for the same address and that was the most common
way a first client setup went wrong.

**The link is only made when the account already owns the domain.** This is
load-bearing, not a formality: without it anyone could register a panel account
as `ceo@some-company.com` before that company added its domain, and the mailbox
would silently authenticate against the squatter's password the moment it was
created. `tests/credentials.test.ts` asserts exactly that, and three of its
tests fail if the condition is relaxed. Do not relax it.

An unlinked mailbox keeps its own hash and has **no panel login at all** — the
other people on a family or team domain. Merging those into the owner's account
would hand them the panel. `setPassword` refuses on a linked mailbox rather than
writing a second hash, which would silently re-split the credential.

Alias and group addresses have no password at all — they are routing entries.

## Instance ownership

The first account created owns the instance (`users.is_owner`). The claim is
made inside the INSERT with `NOT EXISTS (SELECT 1 FROM users)` and guarded by the
partial unique index `users_single_owner_idx`. Signup catches a `23505` on *that
constraint specifically* and retries as a non-owner. Do not widen that catch — it
would swallow the duplicate-email violation.

## Secrets that are deliberately not stored

Three credentials pass through this server and are never persisted, each for a
stated reason. Do not "fix" any of them by adding a column:

- **DNS API tokens** (`core/dnsprovider`) — used for one publish and discarded.
  One can usually rewrite every record on every domain in the account.
- **Card details** — never touch the server at all. The customer enters them on
  the provider's hosted page; only a brand, four digits, and an opaque
  reference come back.
- **Transfer source passwords** — encrypted at rest and erased the moment the
  transfer reaches a terminal state. They are someone else's credential.

Reset and recovery tokens are stored only as SHA-256 hashes, and redeemed with
the `used_at IS NULL` predicate *inside* the UPDATE — checking it in a separate
read lets two concurrent requests both redeem the same link.

## Enumeration

`/api/auth/password/forgot` and `/api/recover/request` always answer the same
way, whatever the truth is, and the login endpoint gives one reply for both an
unknown address and a wrong password. Making any of them more helpful turns it
into a way to enumerate accounts. There are smoke-test cases asserting the
replies are identical — keep them.

## Event hooks

Outbound webhooks are signed with the **Standard Webhooks** scheme (`whsec_`
secret, `webhook-id` / `webhook-timestamp` / `webhook-signature`, HMAC-SHA256
over `id.timestamp.body`), the same as outbox. The `svix-*` aliases go out
alongside so an off-the-shelf verifier works unchanged. Do not invent a
different scheme here.

`emit()` in `src/events` **never throws** and never blocks. It is called from
the SMTP path, where a failure to record a notification must not fail the
delivery that triggered it — the mail is the product, the hook is a courtesy.
Delivery is the worker's job.

**A webhook URL is attacker-supplied and this server fetches it.** That is a
server-side request forgery primitive, so `assertDeliverable` refuses private,
loopback, and link-local addresses. `WEBHOOK_ALLOW_PRIVATE` exists for an
operator whose consumers are on the same private network; it is off by default
because the safe case is the rarer one.

## Plan gating

A feature the plan does not include raises a **402**, not a 403, so the panel can
render an upgrade prompt rather than an error. `requireFeature()` in
`core/plans`. Validation runs before the quota check: a malformed input is
invalid regardless of the plan.

## Adding an endpoint

1. Schema in `src/schema/index.ts`, plus SQL in a new migration
   under `migrations/`. Hand-write the SQL — `migrate.diff` emits no indexes,
   foreign keys, or unique constraints.
2. Add it to `allSchemas` at the bottom of `src/schema/index.ts`. That list is
   explicit on purpose: a table missing from it is a table `diff` will not
   notice has drifted.
3. Confirm it matches: `bun run migrate && bun run migrate:diff` should report
   "schema in sync".
4. Serialiser in `src/serialize/index.ts`, so the response shape lives in one
   place and no secret ever gains a field.
5. Route in `src/api/routes/<area>`, registered in `src/api/index.ts`.
6. A case in `tests/smoke.ts`.

## The docs site

`site/content/**.md` → `site/public/**.html`, rendered by `site/build.ts`. It is
served two ways: by this server for any non-API path, and by GitHub Pages via
`.github/workflows/pages.yml`. Run `bun run site:check` after touching either —
it builds and then fails on a broken internal link or a dead anchor.

**Every emitted link is relative to the page carrying it.** That is what makes
one build work at a domain root, under a `/corsair/` project-page prefix, and off
a local disk. Do not introduce a root-absolute `href` in the layout or in
content; `SITE_MODE=pages` exists for the one place that needed to differ (the
`/app` link, which does not exist behind a static host).

`site:check` also asserts every built page has a markdown source **that git is
tracking**. An unanchored `.gitignore` pattern matches every path segment, and
on a case-insensitive filesystem a root-level `SECURITY.md` rule swallowed
`site/content/docs/security.md`. The committed HTML kept answering 200 while CI
built the site from a checkout without the source, so the page vanished from
every sidebar and became reachable only by typing its URL. Anchor repo-root
ignores with a leading slash.

**There are three copies of the docs and they update separately.** The mail
server serves the committed `site/public` (app mode); GitHub Pages rebuilds from
`site/content` in CI; and `corsair.wess.dev` is a static copy on gohan that only
changes when it is rsynced. Deploying the server updates the first two and does
nothing to the third:

```sh
SITE_MODE=pages SITE_URL=https://corsair.wess.dev bun site/build.ts
bun site/check.ts
rsync -az --delete site/public/ gohan:/srv/corsair.wess.dev/
bun run site:build   # back to app mode before committing
```

That last line matters: `site/public` is committed and the server serves it, so
leaving a pages-mode build in the tree swaps the panel link for a docs link on
the running instance.

A docs page's place in the sidebar comes from its front matter — `section` (one
of the keys in `SECTIONS`) and `order`. A page with no `section` renders without
a sidebar entry and drops out of the previous/next chain, which is the failure
mode to check for when a new page seems to vanish.

The markdown subset is deliberate, not aspirational. It has nested lists, tables,
`:::note` / `tip` / `warning` / `danger` callouts, `- [ ]` checklists, and a
`raw` fence that emits verbatim HTML for the two pages that need a widget. Adding
a dependency to get more is the wrong trade for a mail server.

## Tests

- `bun test` — unit and integration, from `tests/`. Needs Postgres
  (`bun run db:up`). Run with `--concurrency=1`; the integration suites share a
  database.
- `bun run test:smoke` — API contract. Needs a running server; backs off on 429
  because the rate limiter is real.
- `bun run site:check` — the docs site builds and every internal link resolves.
- `bun run test:starttls` — the *outbound* client's STARTTLS, against a real
  handshake.
- `bun run test:starttls:server` — the *inbound* side on all three listeners.
  Prints SKIPPED on a runtime that cannot upgrade an accepted socket, which is
  not a failure; it is the case the probe exists to detect.

## Local setup

```sh
bun install
bun run db:up && bun run migrate && bun run seed
bun run dev
```

Postgres runs in Docker on port 55433 to stay clear of a system install and of
outbox's 55432.
