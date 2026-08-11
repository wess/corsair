---
title: Documentation
description: Everything needed to install, operate, and use Corsair — from a laptop trial to a production mail server.
section: start
order: 1
short: Overview
eyebrow: Corsair manual
---

# Documentation

Corsair is a mail server and the control panel that manages it, in one process.
This manual covers the whole of it: getting a copy running, getting mail to
actually flow, keeping it healthy, and every protocol and endpoint it exposes.

## Pick a starting point

| If you want to | Read |
| --- | --- |
| See it working on your laptop in ten minutes | [Quickstart](quickstart.html) |
| Understand what it is before installing anything | [Introduction](introduction.html) |
| Take a blank VPS to delivered mail | [Your first production server](tutorials/first-server.html) |
| Move a domain off an existing provider | [Migrating from Google Workspace](tutorials/migrate-from-google.html) |
| Know what the host needs first | [Prerequisites](prerequisites.html) |
| Look up an environment variable | [Configuration](configuration.html) |
| Fix something that is broken | [Troubleshooting](troubleshooting.html) |

## How this manual is organised

**Start here** is the shortest path from nothing to a working install, plus the
vocabulary the rest of the manual assumes. If you read three pages, read
[Introduction](introduction.html), [Quickstart](quickstart.html), and
[Core concepts](concepts.html).

**Tutorials** are start-to-finish builds. They tell you what to type and what you
should see, and they end with something that works. Every one of them has been
written against a real install, not sketched.

**Install and operate** is the reference an operator lives in: installation
methods, every setting, TLS, backups, monitoring, upgrades, and what to do at
three in the morning.

**Using Corsair** covers the product surface — domains, addresses, clients,
filters, webmail, migrations, deliverability, and event hooks.

**Reference** is exhaustive rather than narrative: the architecture, the HTTP
API, each mail protocol's supported command set, the database schema, and the
SMTP reply-code lookup.

## What Corsair will not do for you

Running a mail server is four things that are not software: a static IP with a
matching PTR record, port 25 unblocked outbound, a real TLS certificate, and the
ability to bind privileged ports. No amount of good code substitutes for any of
them, and [Prerequisites](prerequisites.html) says so at length before you spend
an afternoon finding out.

:::tip Reading order
Every page in this manual has previous and next links at the bottom, following
the order in the sidebar. Read straight through and you will have covered the
whole system.
:::

## Conventions

`example.com` is always *your* domain — the one whose mail you are hosting.
`mail.example.com` is the Corsair host itself. Commands prefixed with `$` are run
on the server; anything else is a file's contents or a protocol transcript.

Where a page states a default, it is the default in the shipped code, not a
suggestion. Where a page says something is deliberate, there is a reason given —
usually because the obvious alternative breaks something subtle.
