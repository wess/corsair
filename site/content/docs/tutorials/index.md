---
title: Tutorials
description: Start-to-finish builds — a production server, a migration off Google, a household domain, filters, webhooks, and a restore drill.
section: tutorials
order: 1
short: All tutorials
eyebrow: Tutorials
---

# Tutorials

Each of these is a complete build. They say what to type, what you should see,
and what to do when you do not see it. Work through one and you end with
something that runs.

The reference pages tell you what every setting does. These tell you what to do.

## The main path

**[Your first production server](first-server.html)** — about an hour

A blank VPS to delivered, authenticated mail: host setup, DNS, TLS, the first
domain, the first mailbox, and a verified round trip with a real provider. Every
other tutorial assumes you have done this one, or the [Quickstart](../quickstart.html) at least.

## Moving in

**[Migrating from Google Workspace](migrate-from-google.html)** — an evening, plus a wait

Copy the mail across with the MX still pointing at Google, verify the counts,
cut over, then catch the tail. Written for Google because it is the most common
source and the fussiest about app passwords; the shape is the same for anyone.

**[Mail for a household or small team](household.html)** — 30 minutes

Real mailboxes for the people who need them, aliases for the roles, a group for
`family@`, a catch-all for everything else, and self-service recovery so you stop
being the help desk.

## Making it do work

**[A filter cookbook](filter-cookbook.html)** — reference-style

Sieve scripts that solve actual problems: newsletters, sub-address filing,
vacation-shaped rules, flagging by sender, and quarantining without losing mail.
Copy, paste, adjust.

**[Consuming webhooks](webhook-consumer.html)** — 45 minutes

Build a small service that receives Corsair's events, verifies the signature
properly, and stays idempotent under retries. Includes the failure modes that
only appear in production.

## Not losing it

**[A backup and restore drill](backup-drill.html)** — 90 minutes

Take a backup, destroy the install, and bring it back. A backup you have never
restored is not a backup, and the parts people forget — the DKIM keys, the object
store, the `.env` — are exactly the parts that make mail unrecoverable.

:::tip Do the drill
Of everything on this page, the restore drill is the one people skip and the one
that matters most at three in the morning. It takes ninety minutes once.
:::
