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

**Forwarding without SRS breaks.** An alias that forwards keeps the original
envelope sender, whose SPF does not list us, and the next hop sees a forgery.
`packages/smtp/srs` rewrites it. The HMAC is not optional — without it the
rewritten address is an open relay.

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

Two entirely separate identities, and conflating them is the bug to avoid:

- A **user** is a control-panel login (session cookie). It owns domains.
- An **address** is a mailbox credential (SMTP/IMAP/POP3). It owns messages.

An address password never signs into the panel and a user password never signs
into a mail client. Alias and group addresses have no password at all — they are
routing entries.

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

## Tests

- `bun test` — unit and integration, from `tests/`. Needs Postgres
  (`bun run db:up`). Run with `--concurrency=1`; the integration suites share a
  database.
- `bun run test:smoke` — API contract. Needs a running server; backs off on 429
  because the rate limiter is real.

## Local setup

```sh
bun install
bun run db:up && bun run migrate && bun run seed
bun run dev
```

Postgres runs in Docker on port 55433 to stay clear of a system install and of
outbox's 55432.
