---
title: JMAP
description: Session discovery, the supported methods, back-references, and blob upload and download.
section: reference
order: 5
eyebrow: Reference
---

# JMAP

JMAP per [RFC 8620](https://datatracker.ietf.org/doc/html/rfc8620) (core) and
[RFC 8621](https://datatracker.ietf.org/doc/html/rfc8621) (mail), over the same
HTTPS port as the panel.

JMAP is the modern one: a single endpoint taking batched method calls, with
back-references so a client can query and fetch in one round trip, and state
strings so it can ask what changed rather than re-walking a mailbox.

## Session

```sh
curl -u you@example.com:mailbox-password https://mail.example.com/.well-known/jmap
```

Authentication is the **address** identity — HTTP Basic with the mailbox
credential, which is what every JMAP client in the wild sends. A browser client
carrying the `corsair_webmail` cookie is also accepted.

The session resource advertises:

| Capability | |
| --- | --- |
| `urn:ietf:params:jmap:core` | |
| `urn:ietf:params:jmap:mail` | |
| `urn:ietf:params:jmap:submission` | |

Capabilities are advertised rather than stubbed — a client has to be able to
discover what is really there.

## Method calls

```sh
curl -u you@example.com:password https://mail.example.com/jmap \
  -H 'content-type: application/json' \
  -d '{
    "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
    "methodCalls": [
      ["Mailbox/get", { "accountId": "u1", "ids": null }, "0"]
    ]
  }'
```

### Supported methods

| Method | |
| --- | --- |
| `Core/echo` | |
| `Mailbox/get` | |
| `Mailbox/query` | |
| `Mailbox/set` | Create, update, destroy |
| `Email/get` | |
| `Email/query` | Filter and sort |
| `Email/set` | Including moving between mailboxes |
| `Email/changes` | What changed since a state string |
| `Thread/get` | |
| `Identity/get` | |
| `EmailSubmission/set` | Send |

## Back-references

The reason JMAP is worth using. Query and fetch in one round trip, with the
second call referring to the first's result:

```json
{
  "using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
  "methodCalls": [
    ["Email/query", {
      "accountId": "u1",
      "filter": { "inMailbox": "inbox-id" },
      "sort": [{ "property": "receivedAt", "isAscending": false }],
      "limit": 20
    }, "q"],
    ["Email/get", {
      "accountId": "u1",
      "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" },
      "properties": ["subject", "from", "receivedAt", "preview"]
    }, "g"]
  ]
}
```

One request, one response, twenty message summaries. Over IMAP that is a
`SEARCH` followed by a `FETCH`, and over a slow link the difference is
noticeable.

## Incremental sync

`Email/changes` takes the state string from a previous response and returns what
has been created, updated, and destroyed since.

```json
["Email/changes", { "accountId": "u1", "sinceState": "42" }, "c"]
```

That is the JMAP answer to IMAP's `CONDSTORE`, and it is a good deal simpler to
implement correctly on the client side.

## Sending

```json
["EmailSubmission/set", {
  "accountId": "u1",
  "create": {
    "s1": { "emailId": "draft-id", "identityId": "i1" }
  }
}, "s"]
```

Submission runs the same path as SMTP submission: the From address is proven to
belong to the caller, the daily limit is checked, the message is DKIM-signed, a
copy is filed in Sent, and delivery is queued.

## Blobs

**Download:**

```
GET /jmap/download/:accountId/:blobId/:name
```

**Upload:**

```
POST /jmap/upload/:accountId
```

Bounded by `MAX_MESSAGE_BYTES` — 50 MB by default. Over it, the response is
`urn:ietf:params:jmap:error:limit` with `"limit": "maxSizeUpload"`.

:::warning Set your proxy's body limit
nginx defaults `client_max_body_size` to 1 MB, which rejects almost every upload
before Corsair sees it. Set it above `MAX_MESSAGE_BYTES`.
:::

## Errors

Request-level problems use JMAP's own error types rather than the panel API's
envelope:

| Type | Status | Means |
| --- | --- | --- |
| `urn:ietf:params:jmap:error:unauthorized` | 401 | Bad or missing credentials |
| `urn:ietf:params:jmap:error:notJSON` | 400 | The body did not parse |
| `urn:ietf:params:jmap:error:limit` | 400 | Over `maxCallsInRequest` or `maxSizeUpload` |
| `urn:ietf:params:jmap:error:notFound` | 404 | No such blob or part |

Method-level errors come back in the response array, per call, as JMAP requires —
one failing method does not fail the batch.

## The same store

JMAP reads and writes the same `messages` and `folders` rows as IMAP, POP3, and
the webmail. There is no per-protocol copy and no synchronisation step.

A JMAP client and an IMAP client on the same mailbox see each other's changes
immediately. So do the webmail and a phone.

This is also why `MOVE` preserves the row id: JMAP requires an Email's id to
survive a change of mailbox, and IMAP is satisfied either way. Implementing move
as copy-then-expunge would satisfy IMAP and silently break JMAP.

## Clients

Any RFC 8621 client should work. The session resource is at
`https://mail.example.com/.well-known/jmap`, with the full email address and
mailbox password as Basic credentials.

## Not implemented

| | |
| --- | --- |
| `urn:ietf:params:jmap:vacationresponse` | Use a [Sieve filter](filters.html) |
| `urn:ietf:params:jmap:calendars`, `contacts` | Corsair does email |
| `SearchSnippet/get` | |
| Push (`EventSource`, `PushSubscription`) | Poll `Email/changes` |

A client that asks for an unadvertised capability gets told it is not there,
which is what capability advertisement is for.
