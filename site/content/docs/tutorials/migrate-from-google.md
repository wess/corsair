---
title: Migrating from Google Workspace
description: Copy an existing mailbox across with the MX untouched, verify it, cut over, then catch the tail.
section: tutorials
order: 3
short: Migrate from Google
eyebrow: Tutorial
---

# Migrating from Google Workspace

Move a domain off Google without losing mail and without a window where messages
land nowhere. The shape is the same for Fastmail, Zoho, Microsoft 365, or any
other host that speaks IMAP — Google is used here because it is the most common
source and the fussiest about credentials.

The plan: copy everything while the MX still points at Google, verify, cut over,
then run a second pass to catch what arrived during the DNS change.

:::warning Order matters
Do not change the MX first. If you do, mail arrives at Corsair while the bulk of
the mailbox is still at Google, and you spend the migration reconciling two live
mailboxes instead of one live and one frozen.
:::

## Before you start

- Corsair running, with the domain **added and active**
  ([first server](first-server.html))
- The destination mailbox **already created** — a transfer copies *into* an
  existing address
- Admin access to the Google account, or the user's cooperation
- A plan that includes transfers, or an unmetered instance
  ([Plans](../plans-billing.html))

## 1. Create the destination addresses

For every mailbox you are moving, create the matching address in Corsair first.
**Domains → example.com → New mailbox.**

Match the local parts exactly. `sam@example.com` at Google becomes
`sam@example.com` here, or the mail arrives correctly and the person's own
references to their address stop working.

Aliases and groups do not need transfers — they have no mailbox. Recreate them as
[alias or group addresses](../addresses.html) and move on.

## 2. Get an app password from Google

Google will not accept an account password over IMAP. For each mailbox:

1. Sign in to the Google account.
2. Turn on 2-Step Verification if it is not already on. App passwords are not
   offered without it.
3. Go to **App passwords**, generate one, and copy the sixteen characters.
4. Confirm IMAP is enabled in **Gmail → Settings → Forwarding and POP/IMAP**.

:::note Why an app password
It is a credential scoped to one client that you can revoke without changing
anything else. Corsair encrypts it at rest and erases it the moment the transfer
reaches a terminal state — it is someone else's credential and there is no reason
to keep it once the copy is done.
:::

## 3. Start the transfer

**Transfers → New transfer.**

| Field | Value |
| --- | --- |
| Source host | `imap.gmail.com` |
| Source port | `993` |
| Security | SSL/TLS |
| Username | the full address, `sam@example.com` |
| Password | the app password |
| Destination | the Corsair address you created |

Leave the limits empty for the first pass — you want everything.

Press **Start**. The worker picks it up, connects, lists the folders, and begins
copying. The panel shows progress per folder.

## 4. What gets copied

Every selectable folder. Common names are mapped onto the local special-use
folders so you do not end up with two of each:

| Google | Corsair |
| --- | --- |
| `INBOX` | `INBOX` |
| `[Gmail]/Sent Mail` | `Sent` |
| `[Gmail]/Drafts` | `Drafts` |
| `[Gmail]/Trash` | `Trash` |
| `[Gmail]/Spam` | `Junk` |
| `[Gmail]/All Mail` | skipped — every message is already in its own folder |
| anything else | a folder of the same name |

Flags are preserved, so read stays read and flagged stays flagged. **Message
dates are preserved**, which matters more than it sounds: without it a
transferred mailbox sorts as though every message arrived today.

Labels are the one thing that does not survive cleanly. Gmail labels are not
folders — a message with three labels appears in three IMAP folders — so a
multi-labelled message is copied into each. Deduplicate afterwards or accept it.

## 5. Verify before you cut over

Compare counts per folder. In the panel, the address's folder list shows message
counts; in Gmail, each label shows its own.

They will not match exactly, and that is expected:

- `[Gmail]/All Mail` is skipped, so its count has no counterpart
- Multi-labelled messages appear more than once on the Corsair side
- Chat and Google-internal messages are not real mail

What you are checking is that INBOX and Sent are close, and that nothing is
obviously empty.

Sign into the webmail as the mailbox and read a few old messages. Check that
attachments open and that dates look right.

## 6. Cut over

Now change the MX. In the domain's DNS, replace the Google MX records with the
one Corsair gave you.

```
example.com.   MX   10   mail.example.com.
```

Delete the five `aspmx.l.google.com` records. Leaving them in place with a worse
priority means Google keeps receiving mail whenever your server is briefly
unreachable, which is the opposite of a clean cutover.

Also update SPF. If your record was:

```
v=spf1 include:_spf.google.com ~all
```

it becomes:

```
v=spf1 include:mail.example.com -all
```

Keep any other legitimate sender you had in there — a marketing platform, a
ticketing system — or their mail starts failing SPF the moment you tighten to
`-all`.

## 7. Wait out the TTL

For as long as the old MX's TTL, some senders will still resolve to Google.
During that window mail can arrive at either host. This is unavoidable and it is
why there is a step 8.

Watch it arrive:

```sh
journalctl -u corsair -f | grep -i 'accepted\|rcpt'
```

## 8. Run a second pass

Once the TTL has expired and new mail is clearly arriving at Corsair, run the
transfer again with **Newer than** set to the day you changed the MX.

The date filter is applied by the *source* server, so old mail is never
transferred and then discarded — it is never fetched at all. That makes the
second pass fast.

Already-copied messages are copied again, so without the date filter you get
duplicates for the whole mailbox. Set it.

## 9. Turn Google off

Wait a week. Watch for anything still arriving at Google — a forgotten alias, a
group, a calendar invite path. Then delete the Workspace account.

Do not skip the week. Cancelling immediately is how you discover that
`billing@example.com` was a Google group nobody had written down.

## Transfer limits

For very large mailboxes, the three limits exist to make a transfer resumable
rather than all-or-nothing:

| Limit | Effect |
| --- | --- |
| Message limit | Stop after this many messages |
| Size limit | Stop once this many megabytes have been copied |
| Newer than | Only messages at or after this date, filtered by the source |

Run repeatedly with a moving **Newer than** date to walk backwards through a
mailbox that is too big for one sitting.

## When it fails

| Message | Cause |
| --- | --- |
| `AUTHENTICATIONFAILED` | Account password used instead of an app password, or IMAP disabled |
| Connection refused | Wrong host or port. It is `imap.gmail.com:993`, not the webmail address |
| Stalls partway | Google rate-limits sustained IMAP. It resumes; let it |
| `transfer.failed` webhook | The panel shows the error against the transfer |

A failed transfer erases the stored source password, same as a successful one.
Restarting means entering it again — that is deliberate.

## What you did not migrate

Filters, forwarding rules, and vacation responders do not come across. Rebuild
them as [Sieve filters](../filters.html); the
[filter cookbook](filter-cookbook.html) has the common shapes.

Contacts and calendars are not email and Corsair does not host them. Export them
from Google and put them somewhere that does.
