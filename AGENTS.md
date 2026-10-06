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

**Ports 25 and 587 are held by a Rust process, not by Bun.** `engine/` is a
STARTTLS terminator: it relays the session verbatim and intervenes at exactly
two points — it advertises STARTTLS in the EHLO reply, and it performs the
upgrade Bun cannot. Every policy decision stays in Corsair, which listens on
127.0.0.1:2525 and :2587 behind it. Submission on 465 is untouched, because
implicit TLS never needed an upgrade.

The client's address therefore arrives as a *claim* (`XCLIENT`) rather than as a
socket fact, and two rules keep that honest. XCLIENT is refused unless the peer
is in `SMTP_TRUSTED_PROXIES`, decided from the socket and never from the wire.
And the loopback shortcut that skips SPF for "this is us" now requires the
listener to confirm the session arrived directly — `spfExempt` needs both halves,
because behind a terminator *every* message arrives from 127.0.0.1 and the
address alone would hand a free SPF pass to the internet.
`tests/proxy.test.ts` pins both; `bun run test:mxfront` drives a real handshake
through the front into a recording backend and checks the body survives it.

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

## Sending API

`/api/emails` is the transactional-email API shape (the one SDKs already speak)
over the submission path, without a mailbox. Do not name a vendor in docs, UI,
or comments — the shape is the contract.
`src/sending` owns it. The queue and the MX path each call into it, and those
seams are where it bites.

**An API send is a delivery row with an `email_id`.** Everything that treats it
differently branches on that column: `beforeAttempt` settles canceled and
suppressed rows without an attempt, a permanent failure records an event instead
of generating a DSN, and every outcome emits `email.*` rather than `message.*`.
A DSN would be addressed to our own VERP return path and come straight back in
on port 25.

**The bounce address is checked before routing, at RCPT and at DATA.**
`bounces+<uuid>@<domain>` matches only when the uuid is an email sent from that
domain; `bounces+newsletter@` and a customer's real `bounces@` route normally.
Moving the check after `resolveRecipient` hands reports to a catch-all, which
files them as mail and suppresses nothing.

**A report may only speak about the email's own recipients.** The return path
is in the headers every recipient receives, so `applyReport` drops any verdict
naming someone else. Without that, one recipient can forge a DSN and suppress
arbitrary addresses on the sending account. `tests/sending.test.ts` has the case.

**Only a gone address is suppressed.** `isRecipientGone` in `src/reports` takes
`5.1.x`, `5.2.1`, and a status-less 550/551/553 that says the user does not
exist. Widening it to "any 5xx" suppresses people over a content-policy refusal
or a full mailbox, and they silently stop getting their password resets.
`tests/reports.test.ts` pins both directions.

**No attachments by `path`.** Fetching a caller's URL and mailing the response
back out is a full-read request forgery, and the hostname check the webhooks use
does not stop a public name that resolves to a private address. Refused, not
guarded.

**Keys are hashes, cannot mint keys, and belong to the domain's owner.** A
domain administrator manages mailboxes; sending as the domain is not delegated.
`api_keys_scope_chk` keeps a domain-scoped key sending-only.

## Agent email

An agent mailbox is an `addresses` row of type `agent` plus a row in `agents`
holding the token hash (`ca_` prefix). `src/agents` owns it.

**The token is not an `api_keys` row, deliberately.** A `cs_` key sends as a
domain and a `ca_` token reads one inbox; keeping them in separate tables with
separate prefixes and separate pipes (`agentOnly` vs `sending`) means neither can
be accepted where the other belongs. `tests/agents.test.ts` checks both
directions.

**The API key is the mailbox password, on every protocol.** An agent address has
no `password_hash`; `authenticateResolved` sends `agent` addresses to
`authenticateAgent`, which compares the SHA-256 of the presented `ca_…` secret to
`agents.token_hash` in constant time. IMAP, POP3, SMTP submission, the webmail,
JMAP Basic and the HTTP API's Basic auth all reach it through that one funnel, so
a rotated or deleted key stops working everywhere at once. `createAddress` skips
account-linking for it, so an owner who happens to
share an agent's local part cannot end up with the mailbox bound to their
password. The ordinary address route's `type` enum excludes `agent` so every one
is made through `POST /api/agents`, which does the plan-limit check and mints the
token.

**Reads are scoped by `address_id` in the query, not checked after.** A message id
belonging to another agent is a 404, the same as one that does not exist.

**Sending is opt-in and capped on the mailbox.** `agents.can_send` defaults to
false so a prompt injection in mail the agent reads cannot make it a spam
source. The 50-recipients-a-UTC-day cap is `agents.sent_count`, advanced by the one
atomic UPDATE in `reserveSends` — not a count of `mail_log` read before sending,
which two concurrent requests both pass. It is deliberately not
`daily_out_limit`: `withinDailyLimit` counts the whole account's usage against
whatever override it is given, which would let one agent's override throttle
every other mailbox. **Every send path must call `reserveSends`** (the agent API
and webmail via `sendFromMailbox`, SMTP at RCPT, JMAP `EmailSubmission`); a new
path that skips it is a path around the only defence against a prompt-injected
agent mailing strangers. An agent may also only use its *own* address as sender —
`mayUseSender` and JMAP both enforce it, where a person may send as the owner's
other addresses. Webmail and agents both
send through `sendFromMailbox` in `src/mailsend`, so signing and the Bcc rule
live in one place.

**Attachments are always downloads.** `partResponse` in `src/parts` serves
anything but an inline image as `application/octet-stream` with a sandbox CSP;
the agent route passes `inlineImages: false`. The declared type is the sender's.

**`wait` only counts mail that arrives after the call** unless given `since`.
Dropping that default hands an agent last week's verification code.

## Hardening from the 2026-10 audit

A security and stability audit found these; each has a test, and each is the
kind of thing that regresses quietly.

- **A handler must return a `Conn`, never a `Response`.** The router reads only
  `status`, `respHeaders` and `body` off the result, so a `Response` is served
  with every header dropped. Attachment downloads went out with no
  `Content-Disposition`, no `nosniff` and no sandbox CSP that way. `responseConn`
  in `src/parts` adapts one; a body has to be a stream or a string, because the
  router `JSON.stringify`s any other object.
- **Any URL a user supplies goes through `safeFetch`** (`src/safefetch`). It
  resolves the host, judges every address (IPv4-mapped IPv6, NAT64, CGNAT and the
  cloud metadata address included), and does not follow redirects. Webhook
  response bodies are not stored or returned: they were a way to read internal
  services. It does not pin the connection to the checked address, so DNS
  rebinding is a residual risk. The suite runs with `WEBHOOK_ALLOW_PRIVATE=true`
  so webhook tests can use a local server; tests of the check pass `false`.
- **`enqueue` rejects any address with a control character, space, `<`, `>` or
  quote.** The SMTP client writes them into `MAIL FROM:<…>` verbatim, so one with a
  CRLF is a command injected into a remote server's session. This covers every
  caller — JMAP, Sieve `redirect`, forwarding, the sending API.
- **JMAP `EmailSubmission` applies the same sender, daily-limit and agent rules as
  SMTP submission**, using the same `mayUseSender`. It was the one way in that
  checked nothing. Submission also requires the *From header* to pass
  `mayUseSender`, not only the envelope.
- **Every login path is behind the same gate**: failures are recorded and banned
  by IP (JMAP Basic included), argon2 verifies queue behind a limit of four in
  flight (`gated` in `src/auth`), and an unknown address spends the same time as a
  wrong password (`spendVerifyTime`).
- **The server will not start with a default or short `JWT_SECRET`** (`src/secrets`),
  because it signs sessions, keys SRS, and encrypts transfer credentials.
- **Mail loops are cut at 30 `Received:` headers** (554 5.4.6), and an alias cannot
  forward to itself. Both caps exist because each hop costs a queue row and a body.
- **Listeners have idle timeouts and the IMAP buffer is bounded.** Unauthenticated
  IMAP may buffer 8 KB per command (line plus literals); chained LITERAL+ once held
  550 MB on one socket. IMAP `data` chunks are chained per socket, because Bun
  runs an async handler for the next chunk while the last is still awaiting, and
  pipelined commands were being concatenated. The Rust front checks that the
  backend answered XCLIENT with 220, refuses bytes pipelined after STARTTLS, and
  caps idle time, handshake time and connections.
- **`MAX_MESSAGE_BYTES` defaults to 25 MB**: the pipeline holds several copies of a
  message and one 50 MB message peaked near 900 MB on a 1 GB box.
- **Never call `socket.write(string)` directly.** Bun encodes a string as UTF-8, so
  the pipeline's latin1 strings went out double-encoded (`c3 a9` became
  `c3 83 c2 a9`) and every IMAP literal was longer than its `{n}`; and it writes only
  what the kernel will take *now*, returning the count and **dropping the rest** (a
  60 MB write to a slow reader delivered 327 KB). Large FETCH, POP3 RETR and
  outbound DATA bodies were all affected. Every listener and the outbound client
  write through `createWriter` (`src/socketio`): latin1, queued, written on `drain`,
  `settled()` for backpressure, `afterFlush()` before `end()`. Session-level tests
  cannot see any of this — `tests/wire.test.ts` and `tests/wireimap.test.ts` use
  real sockets with a slow reader, and that is the only kind of test that will.
- **IMAP FETCH streams, SEARCH works in slices.** FETCH renders one message at a
  time through the `stream` hook and waits for the client to keep up (without the
  hook — tests — it still returns one string). SEARCH tests 200 messages at a time,
  fetching `search_text` and headers only for those, with at most 4 bodies loading at
  once. `messagesIn` no longer returns `search_text` (up to 100 KB a row); use
  `searchTextFor`.
- **The message path avoids copies.** `normalizeEol` returns the same string when
  there is nothing to fix (it used to copy 25 MB three times); the snippet and
  search extract decode only the head of a body; the DKIM body hash streams a line
  at a time (`bodyHash`, checked against `canonBody` on random input); the outbound
  client dot-stuffs only when it must and the queue loads a stored body once per
  batch for all its rows. A 25 MB message now peaks about +57 MB (attachment) to
  +113 MB (text) through `handleMessage`, down from +113 and +362.
- **Webmail sessions are rows** (`mail_sessions`), like the panel's. The token names
  the row; logout revokes it; changing a mailbox's password, its account link, its
  `disabled` flag, or its owner's account password ends sessions
  (`revokeMailSessions`, and inside `revokeAllSessions` for linked mailboxes).
  Tokens with no session id are refused, so every webmail user signed in again once
  when this shipped.
- **Billing trusts the provider, not the browser.** With `STRIPE_SECRET_KEY` set,
  `POST /api/subscription` for a paid plan and `POST /api/billing/payment-methods`
  are refused: a paid plan starts at hosted checkout and only the signed webhook
  activates it. They used to accept a client-posted "payment method" — a fabricated
  row bought every plan and recorded a `paid` transaction nobody paid. The panel
  sends users to checkout when a provider is configured. Provider config is
  process-wide, so `tests/billingstripe.test.ts` runs twice (`bun run test` does
  both).
- **A bounce is only sent where the evidence supports it** (`mayBounceTo`): the
  sender's SPF passed or a DKIM signature verified. A post-DATA failure for one of
  several recipients cannot go in the reply to DATA, and bouncing it to a forged
  `MAIL FROM` is backscatter that costs this IP its reputation.
- **A bounce for forwarded mail is routed home.** `resolveRecipient` reverses
  `SRS0=` addresses (signature and age checked) into a forward to the original
  sender; a bad or expired one is an unknown address, which is what keeps the
  rewritten form from being an open relay. No mailbox can shadow it: `=` is not
  allowed in a local part.
- **`JWT_SECRET` is a root, not a key.** `keyFor(purpose)` in `src/secrets` derives
  an independent key per purpose with HKDF — panel sessions, webmail sessions, SRS,
  stored transfer credentials — so a token cannot be replayed across purposes and
  none of them is the raw secret. Two things still accept the pre-derivation
  scheme so nothing in flight breaks: SRS addresses (self-expiring, until
  2026-11-03) and transfer credentials (they erase themselves when a transfer
  finishes). Tokens are not carried over: everyone signs in again once.
- **Known and not yet done:** SRS1 (an address already rewritten by another
  forwarder) is rewritten under our domain but cannot be reversed here, since it was
  signed with their key; mail between two mailboxes on this box arrives from
  `127.0.0.1` and softfails SPF (DMARC still passes on DKIM) because the loopback
  exemption deliberately requires a *direct* connection.

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

**`llms.txt` and the agent tools are built, not written.** `site/build.ts`
emits `llms.txt` (an index grouped like the sidebar) and `llms-full.txt` (every
page as markdown), and copies `plugin/skills/agent-email/SKILL.md` and
`plugin/mcp/server.mjs` to `public/agent/`. The plugin is the source of truth, so
the copy a model fetches cannot drift from the one the plugin installs. `llms.txt`
links are **absolute** (following `SITE_URL`) — the one exception to the
relative-links rule, because a model fetches it with no page to resolve against.
`site/check.ts` fails on a dead link in it.

The Claude Code plugin lives in `plugin/` with its marketplace at
`.claude-plugin/marketplace.json`; `claude plugin validate .` checks both. The MCP
server is one dependency-free `.mjs` that must keep running under Node and Bun,
and `tests/mcp.test.ts` drives it over stdio against a stub (no database).

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
- `bun run test:resend` — a third-party SDK (the `resend` package) against a running server,
  with only the base URL changed. The sending API's compatibility claim, checked.
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

## Security follow-up (2026-10)

- Browser mutations pass `checkOrigin` before routing, including custom webmail hosts. API and JMAP responses use `no-store`.
- Transfer and authenticated relay credentials require verified TLS. Bun can report a successful handshake with an authorization error: check `socket.authorized`, the authorization error, and the peer certificate hostname explicitly, even with `rejectUnauthorized` enabled. `tests/transfersecurity.test.ts` and `tests/relaysecurity.test.ts` use real certificates and sockets.
- `safeFetch` connects to its checked IP with the original Host and TLS server name. Transfer sources use the same resolver; the private-network override is separate from the webhook override.
- A storage read outage is a deferral, never evidence that a queued body was deleted. Only a 404 means missing. Downloads have an abort deadline through the body; queue retries retain the object and do not spend a delivery attempt.
- Protocol input goes through `createReader` to serialize and bound pending packets. Its copy owns Bun's callback bytes across awaits. Close both reader and writer when the active socket closes; ignore the obsolete cleartext socket after a TLS upgrade.
- Remote-image permission belongs to one message. Keep the webmail reader keyed by message id so enabling images cannot carry into the next message.
