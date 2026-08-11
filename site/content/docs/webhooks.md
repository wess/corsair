---
title: Event hooks
description: Signed JSON delivered to your endpoint when mail arrives, bounces, or is filed as spam.
section: using
order: 9
short: Event hooks
eyebrow: Using Corsair
---

# Event hooks

Corsair POSTs a JSON payload to an endpoint you choose when something happens.
Add one under **Webhooks** in the control panel.

## Verifying a delivery

Every delivery is signed. **Verify it.** Without the check, anyone who learns
your URL can post whatever they like and your system will believe it.

The scheme is [Standard Webhooks](https://www.standardwebhooks.com), so the
libraries you may already have work unchanged. Three headers:

| Header | Meaning |
| --- | --- |
| `webhook-id` | Unique per delivery. Store it to deduplicate retries. |
| `webhook-timestamp` | Unix seconds. Reject anything more than a few minutes old. |
| `webhook-signature` | `v1,<base64>` — HMAC-SHA256 over `id.timestamp.body` |

The `svix-id`, `svix-timestamp`, and `svix-signature` aliases carry the same
values, for tooling that expects those names.

```js
import { createHmac, timingSafeEqual } from "node:crypto"

const verify = (secret, headers, body) => {
  const id = headers["webhook-id"]
  const timestamp = headers["webhook-timestamp"]
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false

  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
  const expected =
    "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64")

  return headers["webhook-signature"]
    .split(" ")
    .some((candidate) => {
      const a = Buffer.from(expected)
      const b = Buffer.from(candidate)
      return a.length === b.length && timingSafeEqual(a, b)
    })
}
```

Sign over the **raw request body**, exactly as received. Parsing the JSON and
re-serialising it changes the bytes and the signature will not match.

## Events

| Event | When |
| --- | --- |
| `message.received` | A message was accepted and delivered to a mailbox |
| `message.spam` | Accepted, but scored as spam and filed in Junk |
| `message.rejected` | Refused at SMTP time — no such user, over quota, filtered |
| `message.sent` | Accepted from one of your mailboxes for delivery |
| `message.delivered` | The receiving server accepted it |
| `message.deferred` | Temporarily refused; Corsair will retry |
| `message.bounced` | Permanently failed, or retries ran out |
| `address.created` · `address.deleted` · `address.password_changed` | Mailbox changes |
| `domain.created` · `domain.verified` · `domain.verification_failed` · `domain.deleted` | Domain changes |
| `quota.warning` · `quota.exceeded` | Storage |
| `transfer.completed` · `transfer.failed` | Mailbox migration |

Subscribe to exact types, a family with `message.*`, or everything with `*`.
A family wildcard is usually what you want — it picks up new event types in that
family without you changing anything.

## Payload

```json
{
  "type": "message.received",
  "created_at": "2026-08-10T12:00:00.000Z",
  "data": {
    "recipient": "me@example.com",
    "sender": "someone@elsewhere.com",
    "subject": "Hello",
    "message_id": "<abc@elsewhere.com>",
    "size": 4821,
    "spam_score": 1.5,
    "authentication": { "spf": "pass", "dkim": "pass", "dmarc": "pass" },
    "remote_ip": "203.0.113.9"
  }
}
```

## Retries

Answer with any `2xx` and quickly — the body is ignored. Anything else is
retried after 5s, 30s, 5m, 30m, 2h, 5h, 10h, and 24h, then given up on.

Retries reuse the same `webhook-id`, so a receiver that records the id can tell
a retry from a new event. Corsair guarantees *at least once*, not exactly once:
your endpoint should be idempotent.

An endpoint that fails twenty times in a row is disabled automatically, and the
panel says so. Re-enable it once it is fixed.

## Endpoint requirements

The URL has to be reachable from the public internet. Private, loopback, and
link-local addresses are refused, because the URL is customer-supplied and this
server is what fetches it — an open one is a server-side request forgery. A
self-hoster whose consumers are on the same private network can set
`WEBHOOK_ALLOW_PRIVATE=true`.

Use the **Send test** button after adding an endpoint. It delivers a signed
sample synchronously and shows you the exact status and body that came back.
