---
title: Security model
description: What Corsair defends against, what it deliberately does not store, and where the responsibility is yours.
section: operate
order: 11
short: Security
eyebrow: Install and operate
---

# Security model

What Corsair protects, how, and where the boundary is. Read the last section
too — the parts that are your responsibility are not small.

## Two identities, never merged

| | User | Address |
| --- | --- | --- |
| Purpose | Control-panel login | Mailbox credential |
| Credential | Password + optional TOTP | Password |
| Carried by | `corsair_session` cookie, 14 days | The mail protocol, per connection |
| Grants | Domains, billing, webhooks, filters | Messages in one mailbox |

An address password never signs into the panel, and a user password never signs
into a mail client. A mailbox credential is typed into phones, laptops, and
printers; one of those will eventually be lost. When it is, it must not also be
the key to the account that owns every domain.

The webmail uses a **third** thing: a separate `corsair_webmail` cookie with a
12-hour lifetime and a distinct claim, so a panel session cookie cannot be
replayed against it. Shorter because a browser session on a shared machine is
more likely to be left open.

## Passwords and tokens

- Passwords are hashed, never stored or logged in the clear.
- Reset and recovery tokens are stored **only as SHA-256 hashes**.
- A token is redeemed with `used_at IS NULL` **inside the UPDATE**. Checking it in
  a separate read lets two concurrent requests both redeem the same link.
- Sessions are rows, not just JWTs. The signature alone is not enough — a revoked
  session stops working immediately, which a stateless token cannot do.

Two-factor is TOTP. Turn it on for the owner account; it controls every domain.

## Never stored

Three credentials pass through this server and are deliberately not persisted.
Do not "fix" any of them by adding a column.

**DNS API tokens.** Used for one publish, then discarded. One can usually rewrite
every record on every domain in the account — holding it to save a paste is a bad
trade.

**Card details.** They never touch the server. The customer enters them on the
provider's hosted page; a brand, four digits, and an opaque reference come back.
There is no code path here that could accept a card number.

**Transfer source passwords.** Encrypted at rest and erased the moment the
transfer reaches a terminal state, success or failure. They are someone else's
credential.

## Transport

Corsair refuses SMTP `AUTH` and IMAP `LOGIN` on an unencrypted connection when a
certificate is configured — it advertises `LOGINDISABLED` so the client fails at
connect rather than after sending the password.

Port 25 is the deliberate exception: STARTTLS is offered but never required,
because a sending server that does not support it still has legitimate mail, and
refusing means losing that mail.

## Enumeration

Several endpoints are deliberately unhelpful:

- `/api/auth/password/forgot` and `/api/recover/request` answer identically
  whether or not the address exists.
- Login gives **one** reply for both an unknown address and a wrong password.

Making any of them more informative turns it into a way to enumerate accounts.
There are smoke tests asserting the replies are byte-identical — they are not
decoration.

## Server-side request forgery

A webhook URL is attacker-supplied and this server fetches it. That is an SSRF
primitive, so endpoints on private, loopback, and link-local addresses are
refused at creation.

`WEBHOOK_ALLOW_PRIVATE=true` exists for an operator whose consumers are on the
same private network. It is off by default because the safe case is the rarer
one. Turning it on means a customer can point a webhook at your metadata service.

## Content sanitisation

**Rendered mail is sanitised on the server**, never in the client
(`src/sanitize`). Every message a mail server accepts is attacker-supplied by
definition.

The policy is an **allow-list** — unknown tags and attributes are dropped rather
than inspected — because a deny-list has to stay complete as browsers change.
Scripts, event handlers, and `javascript:` URLs are removed before the browser is
handed anything.

Remote images are withheld by default. A remote image in an email is a tracking
pixel; the reader asks for them or does not get them.

## Browser headers

Sanitisation is the first layer. The Content Security Policy is the second, and
it exists because the first one will eventually be wrong about something.

Every response — the JSON API, the panel, and the webmail — carries:

| Header | Value |
| --- | --- |
| `Content-Security-Policy` | `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'` |
| `X-Frame-Options` | `DENY` |
| `Cross-Origin-Opener-Policy` | `same-origin` |
| `Permissions-Policy` | camera, microphone, geolocation and cohort tracking all denied |
| `Strict-Transport-Security` | one year, including subdomains |
| `X-Content-Type-Options` | `nosniff` |

`script-src 'self'` is an honest claim rather than an aspiration: the panel and
the webmail are bundled with no inline script and no `eval`, and there is a test
asserting it stays that way. A policy with `'unsafe-inline'` in it protects
nothing.

`frame-ancestors 'none'` is what stops the webmail being framed by a page that
overlays its own buttons on yours.

:::note Serving Corsair yourself
These come from the application, not from your reverse proxy, so they survive a
proxy misconfiguration. If you add your own, do not weaken these — a second
`Content-Security-Policy` header does not replace the first, but a proxy that
strips and rewrites one does.
:::

## Header injection

A bare CR or LF in a subject, display name, or custom header injects a header.
`stripControls` runs on every value this codebase emits, and there are regression
tests for it.

If you are extending Corsair, anything you write into a header goes through it.

## Rate limiting and bans

- **10 requests/second** per principal by default (`RATE_LIMIT_PER_SECOND`).
- **5/second per IP** on sign-in and sign-up, where there is no principal yet.
- Authentication failures are recorded, and repeated failures produce a ban.

`TRUSTED_PROXIES` must be set when anything sits in front of the HTTP port.
Without it every request appears to come from the proxy: the limiter sees one
client, and a ban bans your own proxy.

## Outbound abuse

Submission proves the From address belongs to the caller before signing anything.
An authenticated user cannot send as a domain they do not own — which is the
difference between a mail server and an open relay.

Forwarded mail is SRS-rewritten. The HMAC in the rewritten address is not
optional: without it, the rewritten address is an open relay for anyone who can
construct one.

Daily send limits come from the plan and are counted from `mail_log`.

## Multi-tenancy

Every query for a user's resources carries the user id in the `WHERE` clause; a
row that does not belong to the caller is a 404, not a 403 — the distinction
leaks existence.

Plan gating raises a **402** so the panel can render an upgrade prompt. Validation
runs before the quota check: a malformed input is invalid regardless of the plan.

## Instance ownership

The first account created owns the instance. The claim is made inside the INSERT
with `NOT EXISTS (SELECT 1 FROM users)` and guarded by a partial unique index, so
two simultaneous signups cannot both win. Signup catches the duplicate-key error
on *that constraint specifically* and retries as a non-owner.

Set `SIGNUPS=closed` on a personal server so only the first account can ever be
created.

## What is yours

Corsair cannot help with any of this:

**The host.** SSH keys only, a firewall allowing just the mail ports and 443, and
patches applied. A compromised host means compromised mail regardless of anything
in the application.

**`.env`.** It holds `JWT_SECRET`, the database password, and the storage keys.
Mode 600, owned by the service user, never committed.

**Database backups.** They contain DKIM private keys, password hashes, and
encrypted transfer credentials. Encrypt them, and never put one in a bucket whose
default is public.

**The bucket.** Objects are written with no ACL and inherit the bucket default.
Verify that default is private, especially on a bucket you already use.

**`JWT_SECRET`.** Anyone who knows it can mint a session for any account. Generate
it randomly; changing it invalidates every session, which is also how you revoke
everything at once.

**Physical access to mail at rest.** Message bodies are not encrypted at rest by
Corsair. Use encrypted volumes and an encrypted bucket if your threat model needs
it — and understand that a server which can serve IMAP can necessarily read the
mail.

## What Corsair does not claim

**Not end-to-end encrypted.** The server reads message content — it has to, to
index, filter, and search. Use PGP or S/MIME in the client if you need content
the server cannot read.

**Not a spam-filtering product.** The scorer is heuristic and deliberately
conservative: a false positive on real mail is far worse than a false negative.
For aggressive filtering, put a dedicated filter in front.

**Not hardened against a hostile operator.** An operator can read every mailbox on
the instance. That is inherent to running a mail server, and it is why you should
run your own rather than trusting someone else's.

## Reporting a vulnerability

Do not open a public issue. Corsair serves a `security.txt` at
`/.well-known/security.txt` with the current contact. Include what you did, what
happened, and what you expected.
