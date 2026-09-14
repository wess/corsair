---
title: Sending API
description: Send transactional mail as your domains over HTTP, with Resend's API.
section: using
order: 9
short: Sending API
eyebrow: Using Corsair
---

# Sending API

Applications — a contact form, a password reset, a receipt — send as your
domains over HTTP, with an API key rather than a mailbox and an SMTP password.

The API is [Resend](https://resend.com/docs/api-reference/introduction)'s: the
same paths, request bodies, response shapes, and error names. Point a Resend SDK
at your server and it works unchanged.

```js
import { Resend } from "resend"

const resend = new Resend("cs_...", { baseUrl: "https://mail.example.com/api" })

await resend.emails.send({
  from: "Acme <receipts@example.com>",
  to: ["customer@example.net"],
  subject: "Your receipt",
  html: "<p>Thanks for your order.</p>",
})
```

Sends ride the same delivery queue as mail from a mailbox, are signed with the
same DKIM key, and count toward the same daily outbound limit. A domain that
already receives mail here needs **no new DNS records** to send through the API.

## Keys

Create a key under **Sending API** in the control panel. The token is shown
once; a lost key is revoked and replaced.

| Access | What it can do |
| --- | --- |
| Sending only | `POST /api/emails` and `POST /api/emails/batch`. Can be limited to one domain. |
| Full access | Also list, read, reschedule, and cancel sends. |

A key sends as any domain its account owns that has finished DNS setup. It cannot
open the control panel, read a mailbox, or create other keys, and it stops
working the moment it is revoked or its account is closed.

:::note
A [domain administrator](domains.html) you delegated mailboxes to cannot create
keys for the domain. Sending as a domain stays with whoever owns it.
:::

## Sending

```sh
curl -X POST https://mail.example.com/api/emails \
  -H 'Authorization: Bearer cs_...' \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "Acme <receipts@example.com>",
    "to": ["customer@example.net"],
    "subject": "Your receipt",
    "html": "<p>Thanks for your order.</p>"
  }'
```

```json
{ "id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c" }
```

| Field | |
| --- | --- |
| `from` | Required. `email@example.com` or `Name <email@example.com>`, on a verified domain of the key's account |
| `to` | Required. One address or a list |
| `cc`, `bcc`, `reply_to` | One address or a list |
| `subject` | Required |
| `html`, `text` | At least one |
| `headers` | Custom headers. The ones this server writes — `From`, `To`, `Subject`, `Message-ID`, `Content-Type` and the like — are refused |
| `tags` | `[{ "name": "...", "value": "..." }]`, ASCII letters, numbers, `_` and `-`. Carried into events |
| `attachments` | `[{ "filename", "content", "content_type", "content_id" }]`. `content` is base64. A `content_id` makes the attachment inline, for `cid:` references in the HTML |
| `scheduled_at` | ISO 8601, or an offset like `in 1 hour`. Up to 30 days ahead |

One email goes to at most 50 addresses across `to`, `cc`, and `bcc`.

`POST /api/emails/batch` takes up to 100 of these as an array and answers
`{ "data": [{ "id": "..." }] }`. Every entry is validated before any is queued, so
a batch with one bad email sends none of them. Attachments and `scheduled_at` are
not accepted in a batch.

### Retrying safely

Send an `Idempotency-Key` header and a retry cannot send twice. For 24 hours a
repeat of a finished request gets the original response back without sending
again. A repeat while the first is still running, or with a different body, gets
`409`.

### What is not supported

- **Attachments by `path`.** The server would fetch a URL you name, from inside
  its own network, and mail the response back out. Send the bytes as `content`.
- **Templates, topics, audiences, broadcasts, and open or click tracking.** This
  is transactional sending. Bulk mail from the same address your mailboxes use
  puts every mailbox's deliverability at risk.
- **Resend's `/domains` and `/api-keys` endpoints.** Domains are managed in the
  control panel, and keys cannot create keys.

## Managing sends

These take a full-access key.

| Method | Path | |
| --- | --- | --- |
| `GET` | `/api/emails` | Newest first. `limit` (1–100, default 20), and `after` or `before` an email id |
| `GET` | `/api/emails/:id` | One email, with its bodies and tags |
| `PATCH` | `/api/emails/:id` | `{ "scheduled_at": "..." }`. Scheduled sends only |
| `POST` | `/api/emails/:id/cancel` | Scheduled sends only |

`last_event` is the most recent thing that happened to any of the email's
recipients: `scheduled`, `sent`, `delivered`, `delivery_delayed`, `bounced`,
`complained`, `failed`, `suppressed`, or `canceled`.

Records of sends are kept for 30 days.

## Events

Outcomes arrive through [event hooks](webhooks.html) as the `email.*` family.

| Event | |
| --- | --- |
| `email.scheduled` | Accepted for a later time |
| `email.sent` | Accepted, or its scheduled time came |
| `email.delivered` | The receiving server accepted it |
| `email.delivery_delayed` | Temporarily refused; Corsair will retry |
| `email.bounced` | Permanently failed, retries ran out, or a bounce report came back |
| `email.complained` | The recipient reported it as spam |
| `email.failed` | This server could not attempt it |
| `email.suppressed` | Not attempted, because the recipient is suppressed |

```json
{
  "type": "email.bounced",
  "created_at": "2026-09-14T15:02:11.407Z",
  "data": {
    "email_id": "4ef9a417-02e9-4d39-ad75-9611e0fcc33c",
    "created_at": "2026-09-14T15:02:09.112Z",
    "from": "Acme <receipts@example.com>",
    "to": ["customer@example.net"],
    "subject": "Your receipt",
    "recipient": "customer@example.net",
    "bounce": { "type": "Permanent", "message": "5.1.1 User unknown", "code": 550 },
    "suppressed": true
  }
}
```

`recipient` says which address the event is about, since one email can be
delivered to one person and bounce for another.

API sends emit `email.*` *instead of* `message.sent`, `message.delivered`,
`message.deferred`, and `message.bounced`. An application's receipts and a
mailbox owner's mail never arrive in the same feed.

## Bounces and suppression

Each send leaves with the return path `bounces+<email id>@<your domain>`. This
server is already your domain's MX, so a report sent back later — most "user
unknown" bounces arrive after the receiving server said yes — comes here. It is
checked before normal routing: a catch-all, or a mailbox you created called
`bounces`, never receives one.

An address is **suppressed**, and the API will not send to it again, when:

- a server says it does not exist — a `5.1.x` status, `5.2.1` (mailbox
  disabled), or a 550, 551, or 553 whose reply says there is no such user
- its recipient reports a message as spam

Every other permanent failure is reported as `email.bounced` and nothing more. A
`5.7.1` policy refusal, a full mailbox, or a message that is too large says
nothing about whether the person is still there.

A report about an address the email was never sent to is ignored. The return
path is visible to everyone who received the message, and without that rule any
one of them could suppress arbitrary addresses on your account.

Suppressions are per account and apply to the API only. Mail written from a
mailbox is never suppressed. See, add, and remove them under **Sending API** in
the control panel.
