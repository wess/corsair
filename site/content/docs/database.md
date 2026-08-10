---
title: Database schema
description: Every table, what it holds, and the constraints that are load-bearing rather than decorative.
section: reference
order: 8
short: Database
eyebrow: Reference
---

# Database schema

Thirty-two tables in PostgreSQL. This is a tour rather than a column-by-column
dump — `src/schema/index.ts` is the authority, and it is readable.

## Accounts

| Table | Holds |
| --- | --- |
| `users` | Control-panel logins. Owns domains |
| `sessions` | Live panel sessions. Rows, not just tokens |
| `tokens` | Email verification, password reset, address recovery |
| `referrals` | Referral tracking |

`users.is_owner` marks the account that owns the instance. The claim is made
inside the INSERT with `NOT EXISTS (SELECT 1 FROM users)` and guarded by the
partial unique index `users_single_owner_idx`, so two simultaneous signups cannot
both win.

Sessions being rows is what makes revocation immediate. A signed token alone
cannot be un-issued.

Tokens store only a **SHA-256 hash** of the token, and are redeemed with
`used_at IS NULL` **inside the UPDATE** — checking it in a separate read lets two
concurrent requests redeem the same link.

## Mail routing

| Table | Holds |
| --- | --- |
| `domains` | Hosted domains and their verification state |
| `domain_records` | The DNS record set with current status |
| `dkim_keys` | Three key pairs per domain, one active |
| `addresses` | Mailboxes and routing entries |
| `address_destinations` | Where an alias or group forwards. One row per recipient |

`addresses.type` is `standard`, `alias`, `catchall`, or `group`. Only `standard`
and `catchall` carry a `password_hash`; the forwarding types have nothing to sign
into.

## Messages

| Table | Holds |
| --- | --- |
| `folders` | One per mailbox folder, with `uid_next` and `uid_validity` |
| `messages` | One delivered message — metadata only |
| `message_blobs` | Inline bodies, when no bucket is configured |
| `message_tombstones` | Expunged messages, until the retention sweep |

`messages` holds what IMAP needs to answer `FETCH`, `SEARCH`, and `SORT` without
pulling a body back: flags, envelope, size, `body_structure`, a `snippet`, and a
`search_text` extract. The raw MIME lives in object storage under `storage_key`,
or in `message_blobs` when there is no bucket.

Flags are a JSON array rather than a Postgres array — `@atlas/db` has no array
column type, and jsonb containment indexes the membership test that actually
runs.

:::danger uid_next is load-bearing
UIDs are allocated with `UPDATE folders SET uid_next = uid_next + 1 … RETURNING`,
which takes a row lock. Never set it by hand, and never restore an old value onto
a folder that has since received mail — a duplicate UID is the one thing an IMAP
client never recovers from.
:::

`message_tombstones` exists because a client that was offline during an expunge
still needs to be told what disappeared.

## Delivery

| Table | Holds |
| --- | --- |
| `deliveries` | The outbound queue, one row per recipient |
| `mail_log` | Every message accepted or emitted, per direction per recipient |
| `bounces` | Permanent failures |

`deliveries` is claimed with `FOR UPDATE SKIP LOCKED`, which is what lets any
number of workers drain it without coordinating. `last_code` and `last_error`
hold the **verbatim** final SMTP reply — operators need the original text, not a
paraphrase, to tell a greylist from a block.

`mail_log.direction` is `inbound` or `outbound`; `status` is one of `accepted`,
`rejected`, `delivered`, `deferred`, `bounced`, or `spam`. The Overview charts,
the per-address activity graph, and the daily send limits are all counted from
it.

## Filtering

| Table | Holds |
| --- | --- |
| `filters` | Sieve scripts, owned by the account |

A filter belongs to a user and can be attached to any number of addresses, which
is why a "file newsletters" rule is written once.

## Billing

| Table | Holds |
| --- | --- |
| `plans` | The plan ladder. Rows, not constants |
| `subscriptions` | One live subscription per account |
| `transactions` | Charges |
| `payment_methods` | Brand, last four, opaque reference. **Never a card number** |
| `tax_ids` | Per-account tax identifiers |
| `payment_events` | Provider webhook deliveries, for idempotency |

Plans are rows so a self-hoster can price, rename, or delete them without a
deploy — and so an instance that charges nobody can run one unlimited plan, or
none at all.

`subscriptions.cancel_at_period_end` rather than an immediate delete: a cancelled
subscription keeps serving mail until the period it was paid for runs out.

## Operations

| Table | Holds |
| --- | --- |
| `jobs` | The worker queue |
| `transfers` | IMAP migrations from another host |
| `rate_limits` | Token buckets |
| `audit_events` | Notable account actions |
| `auth_failures` | Failed sign-ins, for banning |
| `bans` | Blocked IPs |

`jobs.kind` is `domain.verify`, `transfer.run`, `quota.recompute`, or
`retention.sweep`.

`transfers` holds the source password **encrypted**, and erases it the moment the
transfer reaches a terminal state. It is someone else's credential.

## Webhooks

| Table | Holds |
| --- | --- |
| `webhooks` | Endpoints, their subscriptions, and their health |
| `webhook_events` | One row per endpoint per event |
| `webhook_attempts` | Each delivery attempt with its result |

`webhooks.consecutive_failures` drives automatic disabling at twenty.

## Types that will catch you out

**BIGINT arrives as a JS `bigint`**, which `JSON.stringify` refuses. Every byte
count, UID, and modseq in this schema is one. `num()` in `src/db` converts on the
way out.

**Bun's Postgres driver does not bind a JS array to a Postgres array.** Pass the
array and expand it with `jsonb_array_elements_text`. Do **not** `JSON.stringify`
it first — that produces a jsonb *scalar*, and Postgres answers `cannot extract
elements from a scalar`.

**`@atlas/db` has no `RETURNING *`.** `returning()` is typed over the schema's
column keys and emits nothing when given none. Use `...allColumns(schema)` from
`src/db`.

**`WhereBuilder` has no `.and()`.** Return an array of predicates from the
callback and they are ANDed. Delete is `.del()`, not `.delete()`.

## Migrations

Hand-written SQL under `migrations/`, applied by `bun scripts/migrate.ts up`.

`migrate.diff` compares the live schema against `allSchemas` and writes a
migration for the difference — but it emits **no indexes, foreign keys, or unique
constraints**. Those are always written by hand, which is why the migrations are
hand-written rather than generated.

## Adding a table

1. Schema in `src/schema/index.ts`, plus SQL in a new migration.
2. Add it to `allSchemas` at the bottom of that file. The list is explicit on
   purpose: a table missing from it is a table `diff` will not notice has
   drifted.
3. `bun run migrate && bun run migrate:diff` should report "schema in sync".
4. Serialiser in `src/serialize/index.ts`, so the response shape lives in one
   place and no secret ever gains a field.
5. Route in `src/api/routes/<area>`, registered in `src/api/index.ts`.
6. A case in `tests/smoke.ts`.

## Querying it directly

```sh
psql "$DATABASE_URL"
```

Read freely. Write carefully — `uid_next`, `uid_validity`, and `is_owner` all have
invariants the application depends on, and none of them are enforced by a check
constraint that will save you.
