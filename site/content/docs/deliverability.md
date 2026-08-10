---
title: Deliverability
---

# Deliverability

Getting mail *accepted* is a different problem from sending it, and it is mostly
not a software problem.

## The non-negotiables

1. **A PTR record** on the sending IP that matches `CORSAIR_HOSTNAME`, and a
   forward record that resolves back. Mismatched, and the large providers reject
   on connect.
2. **SPF, DKIM, and DMARC** published for every sending domain. Corsair refuses
   to send from a domain that has not finished DNS setup, precisely so this
   cannot go wrong quietly.
3. **A clean IP.** Check it against the common blocklists before committing.
   Cheap VPS ranges are frequently listed before you ever boot the machine.

## Warming up

A brand new IP sending a thousand messages on its first day looks exactly like a
compromised host. Start small, keep the volume steady, and let it build over a
couple of weeks. Nothing about this is enforced by the software — it is how the
receivers' reputation systems work.

## Reading the signals

- **Greylisting** (`450 4.2.0`) on a first attempt is normal and needs no
  action. The retry is accepted.
- **`550 5.7.26`** means no aligned SPF or DKIM. Your DNS is wrong or
  incomplete — this one is entirely fixable.
- **`421 4.7.0`** is rate limiting. Back off; it is not a configuration error.
- **Sudden bulk rejection from one provider** is usually reputation, and usually
  follows a spike in volume or a bounce rate that went up.

## Bounces

Corsair suppresses nothing automatically, but it records every bounce. Repeatedly
delivering to an address that hard-bounces is one of the fastest ways to damage a
sending reputation — treat a `5xx` as permanent and stop.

## MTA-STS

Corsair serves an MTA-STS policy at `/.well-known/mta-sts.txt` in `testing` mode.
Once you have watched the reports and are confident the MX list is right, change
it to `enforce`. Going straight to enforce with a wrong MX list silently
blackholes your inbound mail.
