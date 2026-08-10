---
title: Consuming webhooks
description: Build a service that receives Corsair's events, verifies the signature correctly, and survives retries.
section: tutorials
order: 6
short: Webhook consumer
eyebrow: Tutorial
---

# Consuming webhooks

Build a small service that receives Corsair's events and acts on them. About
forty-five minutes, and most of that is getting the signature verification right —
which is the part that matters, because an unverified endpoint is one anybody who
learns the URL can write to.

[Event hooks](../webhooks.html) is the reference. This is the build.

## What we are building

A service that receives `message.received` and `message.bounced`, verifies the
signature, deduplicates retries, and writes a line to a log. Small enough to
read; complete enough that the failure modes show up.

## 1. Write the receiver

```ts
import { createHmac, timingSafeEqual } from "node:crypto"

const SECRET = process.env.CORSAIR_WEBHOOK_SECRET!
const TOLERANCE_SECONDS = 300

const verify = (headers: Headers, body: string): boolean => {
  const id = headers.get("webhook-id")
  const timestamp = headers.get("webhook-timestamp")
  const signature = headers.get("webhook-signature")
  if (!id || !timestamp || !signature) return false

  // Without the age check, a captured delivery replays forever.
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(Date.now() / 1000 - ts) > TOLERANCE_SECONDS) return false

  const key = Buffer.from(SECRET.replace(/^whsec_/, ""), "base64")
  const expected =
    "v1," + createHmac("sha256", key).update(`${id}.${ts}.${body}`).digest("base64")

  // The header may carry several space-separated signatures during a secret
  // rotation. Any one matching is a pass.
  return signature.split(" ").some((candidate) => {
    const a = Buffer.from(expected)
    const b = Buffer.from(candidate.trim())
    return a.length === b.length && timingSafeEqual(a, b)
  })
}

const seen = new Set<string>()

Bun.serve({
  port: 8080,
  async fetch(req) {
    if (req.method !== "POST") return new Response("Method not allowed", { status: 405 })

    // Read the body verbatim. The signature covers the exact bytes.
    const body = await req.text()

    if (!verify(req.headers, body)) {
      return new Response("Bad signature", { status: 401 })
    }

    const id = req.headers.get("webhook-id")!
    if (seen.has(id)) return new Response("ok")   // a retry of something we did
    seen.add(id)

    const event = JSON.parse(body)
    console.log(`[${event.type}]`, JSON.stringify(event.data))

    // Answer immediately. Do the slow part elsewhere.
    queueMicrotask(() => handle(event))
    return new Response("ok")
  },
})

const handle = (event: { type: string; data: Record<string, unknown> }) => {
  switch (event.type) {
    case "message.received":
      console.log(`  → ${event.data.sender} to ${event.data.recipient}`)
      break
    case "message.bounced":
      console.log(`  → bounced: ${event.data.recipient}`)
      break
  }
}
```

```sh
CORSAIR_WEBHOOK_SECRET=whsec_... bun run receiver.ts
```

:::danger Sign over the raw body
Parse the JSON and re-serialise it and the bytes change — different key order,
different whitespace — and the signature will never match. Read the body as text,
verify, *then* parse. This is the single most common webhook bug.
:::

## 2. Expose it

The endpoint must be reachable from the public internet. Private, loopback, and
link-local addresses are refused at creation, because the URL is customer-supplied
and Corsair is what fetches it — an open one is a server-side request forgery
primitive.

For development, tunnel it:

```sh
ssh -R 80:localhost:8080 nokey@localhost.run
```

For a self-hosted setup where the consumer really is on the same private network
as Corsair, set `WEBHOOK_ALLOW_PRIVATE=true` on the server. It is off by default
because the safe case is the rarer one.

## 3. Register the endpoint

**Webhooks → New endpoint** in the panel.

| Field | Value |
| --- | --- |
| URL | your public HTTPS URL |
| Description | something you will recognise in a list |
| Events | `message.received`, `message.bounced` |

The signing secret is shown **once**, at creation. It is a credential; an endpoint
that has lost it should rotate rather than read it back. Copy it into
`CORSAIR_WEBHOOK_SECRET` now.

Subscribe to a family with `message.*` or to everything with `*`. A family
wildcard is usually right — it picks up new event types in that family without
you changing anything.

## 4. Test it

Press **Send test**. It delivers a signed sample synchronously and shows you the
exact status and body that came back, which is far more useful than watching a
queue.

If it fails:

| What you see | Cause |
| --- | --- |
| Connection refused | Tunnel down, or the URL is wrong |
| 401 from your service | Secret mismatch, or you parsed before verifying |
| Timeout | Your handler is doing the work inline. Answer first |

## 5. Make it survive retries

Corsair guarantees **at least once**, not exactly once. Your endpoint must be
idempotent.

Retries reuse the same `webhook-id`, so recording the id is enough to tell a
retry from a new event. The `Set` above works for a demo; use a table with a
unique index in anything real:

```sql
CREATE TABLE webhook_events (
  id          text PRIMARY KEY,
  type        text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
```

```ts
const fresh = await db.query(
  "INSERT INTO webhook_events (id, type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id",
  [id, event.type],
)
if (!fresh.rows.length) return new Response("ok")   // already handled
```

The insert is the deduplication. Checking first and inserting after is a race two
concurrent retries will win.

## 6. Answer fast

Answer with any `2xx`, quickly. The body is ignored.

Anything else is retried after **5s, 30s, 5m, 30m, 2h, 5h, 10h, and 24h**, then
given up on. An endpoint that fails **twenty times in a row** is disabled
automatically, and the panel says so — Corsair will not hammer a dead endpoint
forever.

So: verify, deduplicate, enqueue, return. Never do the work inside the request.

## 7. Watch it in the panel

**Webhooks → your endpoint → Events** lists every delivery with its status,
attempt count, and next attempt time. Open one to see the payload that was sent
and replay it if you need to.

Replay redelivers the same event with the same id — which is exactly the case
your deduplication is for. Test it: replay something you have already handled and
confirm nothing happens twice.

## The events you get

| Event | When |
| --- | --- |
| `message.received` | Accepted and delivered to a mailbox |
| `message.spam` | Accepted, scored as spam, filed in Junk |
| `message.rejected` | Refused at SMTP time |
| `message.sent` | Accepted from one of your mailboxes for delivery |
| `message.delivered` | The receiving server accepted it |
| `message.deferred` | Temporarily refused; Corsair will retry |
| `message.bounced` | Permanently failed, or retries ran out |
| `address.created`, `address.deleted`, `address.password_changed` | Mailbox lifecycle |
| `domain.created`, `domain.verified`, `domain.verification_failed`, `domain.deleted` | Domain lifecycle |
| `quota.warning`, `quota.exceeded` | Storage |
| `transfer.completed`, `transfer.failed` | Mailbox migration |

A `message.received` payload:

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

## Things worth building on this

- **A bounce suppression list.** Record every `message.bounced` recipient and stop
  sending to it. Repeatedly delivering to an address that hard-bounces is one of
  the fastest ways to damage a sending reputation.
- **A quota alarm.** `quota.warning` into whatever pages you.
- **An archive.** `message.received` into cold storage, keyed by `message_id`.
- **Deployment gating.** `domain.verification_failed` is usually someone editing
  DNS. Find out from a webhook rather than from a customer.

## Using an off-the-shelf verifier

The scheme is [Standard Webhooks](https://www.standardwebhooks.com), and the
`svix-id`, `svix-timestamp`, and `svix-signature` aliases go out alongside the
standard headers. A Svix verification library works unchanged:

```ts
import { Webhook } from "svix"
const wh = new Webhook(process.env.CORSAIR_WEBHOOK_SECRET!)
const event = wh.verify(body, Object.fromEntries(req.headers))
```

Do not invent a different scheme, and do not skip verification because the URL is
hard to guess. It is not a secret; it is in your logs, your proxy's logs, and
anywhere the URL has ever been pasted.
