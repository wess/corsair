---
title: HTTP API
description: Authentication, error envelope, pagination, and every endpoint the control panel is built on.
section: reference
order: 2
short: HTTP API
eyebrow: Reference
---

# HTTP API

The API the control panel is built on. Everything under `/api`, JSON in and JSON
out.

There is no separate API-key mechanism: the panel API authenticates with the same
session cookie a browser gets. If you are automating against it, sign in and keep
the cookie.

## Authentication

```sh
curl -c jar -X POST https://mail.example.com/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"..."}'

curl -b jar https://mail.example.com/api/auth/me
```

The session is a `corsair_session` cookie, `HttpOnly`, `SameSite=Lax`, valid for
**14 days**.

Sessions are rows, not just signed tokens. The signature alone is not enough — a
revoked session stops working immediately, which a stateless token cannot do.

:::note Two identities
This is the **user** identity — the control-panel login that owns domains. The
webmail and JMAP endpoints use the **address** identity instead, with its own
cookie or HTTP Basic. See [Core concepts](concepts.html).
:::

## Errors

One shape, everywhere:

```json
{
  "statusCode": 404,
  "name": "not_found",
  "message": "Domain not found."
}
```

`name` is the machine-readable slug to switch on. It stays stable even when the
message is reworded, so never match on `message`.

| `name` | Status | Means |
| --- | --- | --- |
| `validation_error` | 400 | The payload failed validation |
| `invalid_parameter` | 400 | A parameter has an invalid value |
| `unauthorized` | 401 | Not signed in |
| `plan_required` | 402 | The plan does not include this feature |
| `forbidden` | 403 | Signed in, but not allowed |
| `not_found` | 404 | No such resource, or not yours |
| `method_not_allowed` | 405 | Wrong verb for this endpoint |
| `conflict` | 409 | A record with these values already exists |
| `quota_exceeded` | 413 | Over a plan limit |
| `missing_required_field` | 422 | A required field is absent |
| `rate_limit_exceeded` | 429 | Too many requests |
| `application_error` | 500 | A bug. Please report it |

**402 rather than 403** for plan gating, so a client can render an upgrade prompt
rather than an error.

**404 rather than 403** for a resource belonging to another account. The
distinction would leak existence.

Postgres constraint violations are translated rather than surfaced as 500s — a
unique violation is a 409.

## Rate limits

Ten requests per second per principal by default
(`RATE_LIMIT_PER_SECOND`); unauthenticated requests are limited per IP. Sign-in
and sign-up have their own limit of **five per second per IP**.

A 429 carries:

```
retry-after: 1
ratelimit-limit: 10
ratelimit-remaining: 0
ratelimit-reset: 1
```

## Pagination

List endpoints take `page`, `per_page`, `search`, `sort`, and `direction`.

`per_page` must be one of **10, 25, 50, 100**; anything else falls back to 10.
`direction` is `asc` or `desc`. Sort columns are chosen from a per-endpoint
whitelist, so an unrecognised `sort` is ignored rather than erroring.

```json
{
  "object": "list",
  "data": [ ... ],
  "page": 1,
  "per_page": 10,
  "total": 42,
  "pages": 5
}
```

Offset pagination, deliberately: the panel's tables are numbered, a total needs a
count, and every table is scoped to one account so the offset never walks far.

## Endpoints

### Authentication

| Method | Path | Does |
| --- | --- | --- |
| POST | `/api/auth/signup` | Create an account. The first one owns the instance |
| POST | `/api/auth/login` | Sign in |
| POST | `/api/auth/logout` | Sign out |
| GET | `/api/auth/me` | The current user |
| POST | `/api/auth/verify/send` | Send an email verification |
| POST | `/api/auth/verify` | Redeem a verification token |
| POST | `/api/auth/password/forgot` | Request a reset |
| POST | `/api/auth/password/reset` | Redeem a reset token |
| POST | `/api/auth/totp/setup` | Begin two-factor enrolment |
| POST | `/api/auth/totp/enable` | Confirm and enable |
| POST | `/api/auth/totp/disable` | Disable |

`/api/auth/password/forgot` always answers the same way whether or not the
address exists, and login gives one reply for both an unknown address and a wrong
password. Making either more helpful turns it into a way to enumerate accounts.

### Account

| Method | Path | Does |
| --- | --- | --- |
| PATCH | `/api/account` | Update the profile |
| DELETE | `/api/account` | Delete the account |
| POST | `/api/account/email` | Change the email address |
| POST | `/api/account/password` | Change the password |
| PATCH | `/api/account/notifications` | Notification preferences |
| GET | `/api/account/sessions` | Active sessions |
| POST | `/api/account/sessions/revoke-others` | Revoke every other session |
| GET | `/api/account/referrals` | Referral data |

### Domains

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/domains` | List |
| POST | `/api/domains` | Add a domain |
| GET | `/api/domains/:domain_id` | Read |
| PATCH | `/api/domains/:domain_id` | Update |
| DELETE | `/api/domains/:domain_id` | Delete, with its addresses and their mail |
| GET | `/api/domains/:domain_id/dns` | The record set with current status |
| GET | `/api/domains/:domain_id/dns/zone` | Zone-file export |
| GET | `/api/domains/:domain_id/dns/provider` | Detected DNS provider |
| POST | `/api/domains/:domain_id/dns/publish` | Publish via the provider's API |
| POST | `/api/domains/:domain_id/check` | Re-run the DNS check now |
| GET | `/api/domains/:domain_id/keys` | DKIM keys |
| POST | `/api/domains/:domain_id/keys/:key_id/activate` | Switch the signing selector |
| POST | `/api/domains/:domain_id/fallback` | Set the fallback domain |
| GET | `/api/domains/:domain_id/addresses` | Addresses on this domain |
| POST | `/api/domains/:domain_id/addresses` | Create an address |

The API token posted to `dns/publish` is used for that one call and never stored.

### Addresses

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/addresses/:address_id` | Read |
| PATCH | `/api/addresses/:address_id` | Update |
| DELETE | `/api/addresses/:address_id` | Delete, with its mail |
| POST | `/api/addresses/:address_id/password` | Change the mailbox password |
| POST | `/api/addresses/:address_id/recovery` | Set the recovery address |
| GET | `/api/addresses/:address_id/folders` | Folders with counts |
| GET | `/api/addresses/:address_id/activity` | Recent mail activity |

### Filters

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/filters` | List |
| POST | `/api/filters` | Create |
| POST | `/api/filters/validate` | Compile a script without saving |
| GET | `/api/filters/:filter_id` | Read |
| PATCH | `/api/filters/:filter_id` | Update |
| DELETE | `/api/filters/:filter_id` | Delete |

`/api/filters/validate` is registered **before** `/api/filters/:filter_id`. The
router matches in registration order and does not rank static segments above
dynamic ones.

### Transfers

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/transfers` | List |
| POST | `/api/transfers` | Start one |
| GET | `/api/transfers/destinations` | Addresses available as a destination |
| GET | `/api/transfers/:transfer_id` | Read |
| DELETE | `/api/transfers/:transfer_id` | Cancel |

The source password is encrypted at rest and erased the moment the transfer
reaches a terminal state.

### Webhooks

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/webhooks` | List |
| POST | `/api/webhooks` | Create. The signing secret is returned **once** |
| GET | `/api/webhooks/:webhook_id` | Read |
| PATCH | `/api/webhooks/:webhook_id` | Update |
| DELETE | `/api/webhooks/:webhook_id` | Delete |
| POST | `/api/webhooks/:webhook_id/rotate` | New signing secret |
| POST | `/api/webhooks/:webhook_id/test` | Deliver a signed sample synchronously |
| GET | `/api/webhooks/events` | Events across every endpoint |
| GET | `/api/webhooks/:webhook_id/events` | Events for one |
| GET | `/api/webhooks/:webhook_id/events/:event_id` | One event with its payload |
| POST | `/api/webhooks/:webhook_id/events/:event_id/replay` | Redeliver it |

Listing shows only a prefix of the signing secret — enough to tell two apart. An
endpoint that has lost its secret should rotate rather than read it back.

### Billing

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/plans` | Visible plans, ordered by position |
| GET | `/api/entitlement` | The current account's entitlement and usage |
| POST | `/api/subscription` | Subscribe to a plan |
| POST | `/api/subscription/cancel` | Cancel at period end |
| GET | `/api/billing/provider` | Which payment provider is configured |
| POST | `/api/billing/checkout/subscription` | Hosted checkout for a subscription |
| POST | `/api/billing/checkout/setup` | Hosted checkout to add a payment method |
| GET | `/api/billing/payment-methods` | List |
| POST | `/api/billing/payment-methods` | Record one |
| POST | `/api/billing/payment-methods/:method_id/default` | Make default |
| DELETE | `/api/billing/payment-methods/:method_id` | Remove |
| GET | `/api/billing/transactions` | List |
| GET | `/api/billing/transactions/:transaction_id` | Read |
| GET | `/api/billing/tax-id` | Read |
| PUT | `/api/billing/tax-id` | Set |

### Recovery

Reached by mailbox owners who are not panel users at all, so it lives outside
`/app`.

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/recover/check` | Whether recovery is available for a domain |
| POST | `/api/recover/request` | Request a mailbox password reset |
| POST | `/api/recover/reset` | Redeem the token |

`/api/recover/request` answers identically whether or not the address exists.

### Dashboard

| Method | Path | Does |
| --- | --- | --- |
| GET | `/api/overview` | Everything the Overview screen renders |
| GET | `/api/client-config` | Hostnames and ports for mail clients |

### Webmail

The **address** identity, via the `corsair_webmail` cookie. A 12-hour session.

| Method | Path | Does |
| --- | --- | --- |
| POST | `/api/mail/login` | Sign in with a mailbox credential |
| POST | `/api/mail/logout` | Sign out |
| GET | `/api/mail/me` | The current mailbox |
| GET | `/api/mail/folders` | List |
| POST | `/api/mail/folders` | Create |
| DELETE | `/api/mail/folders/:folder_id` | Delete |
| GET | `/api/mail/messages` | List, with search and pagination |
| GET | `/api/mail/messages/:message_id` | One message, sanitised |
| GET | `/api/mail/messages/:message_id/raw` | The raw MIME |
| GET | `/api/mail/messages/:message_id/part/:section` | One MIME part |
| POST | `/api/mail/messages/flags` | Set or clear flags |
| POST | `/api/mail/messages/move` | Move between folders |
| POST | `/api/mail/messages/delete` | Delete |
| POST | `/api/mail/send` | Send |
| POST | `/api/mail/drafts` | Save a draft |

Message bodies are sanitised server-side before this endpoint returns them.

### Payment provider webhook

| Method | Path | Does |
| --- | --- | --- |
| POST | `/api/webhooks/payments` | Settlement callbacks |

Reads the body verbatim and verifies the signature before parsing.

## Outside `/api`

| Method | Path | Does |
| --- | --- | --- |
| GET | `/.well-known/jmap` | JMAP session resource |
| POST | `/jmap` | JMAP method calls |
| GET | `/jmap/download/:accountId/:blobId/:name` | Blob download |
| POST | `/jmap/upload/:accountId` | Blob upload |
| GET | `/mail/config-v1.1.xml` | Thunderbird autoconfig |
| POST | `/autodiscover/autodiscover.xml` | Outlook autodiscover |
| GET | `/.well-known/mta-sts.txt` | MTA-STS policy |
| GET | `/.well-known/security.txt` | Vulnerability contact |

See [JMAP](jmap.html).

## Route ordering

The router matches in **registration order** and does not rank static segments
above dynamic ones. Two consequences worth knowing if you are extending it:

- `/api/filters/validate` must be registered before `/api/filters/:filter_id`
- `addressRoutes` is registered before `domainRoutes` so
  `/api/domains/:domain_id/addresses` is not swallowed by a domain pattern

`src/api/index.ts` documents the intended order.

## Serialisation

Every response shape comes from `src/serialize`. Keeping it in one place is what
stops a secret gaining a field: a password hash, a DKIM private key, or a stored
provider reference has to be added deliberately to be exposed, rather than
appearing because someone returned a row.

Objects carry an `object` discriminator (`"domain"`, `"address"`, `"webhook"`,
`"list"`) so a client can tell them apart without inspecting shape.
