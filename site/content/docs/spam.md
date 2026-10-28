---
title: Spam filtering
description: How inbound mail is scored, which blocklists are asked, greylisting, and why mail from people you write to is trusted.
section: using
order: 7
eyebrow: Using Corsair
---

# Spam filtering

Corsair scores every message arriving on port 25 and files anything at or above
**5** in `Junk`. It does not reject on a score: a heuristic that refuses mail loses
real mail silently, and nobody finds out until someone asks why they never got a
reply.

What it scores is deliberately narrow. There is no Bayesian filter, no rules
engine, and no AI classifier — each of those needs training data and a feedback
loop, and a half-built one produces exactly the false positives that make people
stop trusting the Junk folder. What is here are signals that are cheap, stable,
and mostly about *who sent the message* rather than what it says.

## What is scored

| Signal | Points |
| --- | --- |
| DMARC fails / passes | +4 / −2 |
| SPF fails, soft-fails / passes | +3, +1 / −1 |
| DKIM fails, absent / passes | +2, +0.5 / −1 |
| No reverse DNS for the client | +1.5 |
| HELO is not a hostname | +1.5 |
| Missing From, Message-ID, or Date | +2, +1, +1 |
| A link whose text names a different host than its target | +3 |
| Client on an IP blocklist | see below |
| A sender or link domain on a domain blocklist | see below |
| Sender is someone this mailbox has written to | −5 |

Every message carries the verdict in two headers, written above anything the
sender supplied:

```
X-Spam-Status: Yes, score=7.5 required=5
X-Spam-Reasons: +3 SPF failed;
	+0.5 no DKIM signature;
	+3 client 198.51.100.7 is on zen.spamhaus.org (PBL)
```

A [filter](./filters.html) can match on either. A filter's own `fileinto` always
wins over the Junk decision.

## Blocklists

The connecting client's IP is looked up on `SPAM_DNSBL` (default
`zen.spamhaus.org`), and the sender's domains plus up to 20 domains from links in
the body are looked up on `SPAM_URIBL` (default `dbl.spamhaus.org`). Lookups run in
parallel with SPF and DKIM, share a 1.5 second budget, and are cached for ten
minutes. A list that does not answer in time counts as no listing.

| Listing | Points | Refused with `SPAM_DNSBL_REJECT` |
| --- | --- | --- |
| ZEN SBL, DROP, XBL | +9 | yes |
| ZEN CSS | +5 | yes |
| ZEN PBL | +3 | no |
| DBL phishing, malware, botnet | +9 | no |
| DBL spam domain | +6 | no |
| DBL abused legitimate domain | +1.5 | no |
| Any other list, `127.0.0.x` | +3 | no |

The host listings outweigh every authentication bonus together, on purpose: SPF
and DKIM prove whose mail it is, and a spam operation authenticates its own domain
like anyone else. PBL does not. It means "this range is not meant to send mail
directly", which describes a self-hoster on a home connection as well as an
infected laptop, so it nudges the score rather than deciding it.

Only the connecting IP is ever checked, never the addresses in `Received:`
headers. So PBL never counts against someone who sent from home through their
provider, and mail relayed by a forwarder is judged by the forwarder's IP.
Submission on 587 and 465 is not checked at all. Behind the STARTTLS terminator,
the IP checked is the one `XCLIENT` reports, not `127.0.0.1`.

:::warning Spamhaus will not answer a public resolver
Spamhaus refuses queries from public DNS services and from most cloud providers'
default resolvers. It does not answer with an error. It answers with
`127.255.255.254`, which looks exactly like a listing to anything that only asks
whether the name resolved. Corsair reads every `127.255.255.x` answer as "no
answer", and logs this once per list:

```
[corsair] zen.spamhaus.org refused a query (answered 127.255.255.254) ...
```

If you see it, blocklists are doing nothing. Run a local recursive resolver
(`unbound` is the usual choice) and set `SPAM_RESOLVER=127.0.0.1`.
:::

An answer outside `127.0.0.0/24` and `127.0.1.0/24` is ignored too. Some ISP
resolvers rewrite "no such name" into the address of their own search page, and
reading that as a listing would put every message in Junk.

### Refusing listed clients

`SPAM_DNSBL_REJECT=true` refuses a client on SBL, CSS, DROP, or XBL at `RCPT` with
`554 5.7.1 Service unavailable; client host [...] blocked using zen.spamhaus.org`.
It is off by default. A listing is a third party's judgement, not Corsair's, and
listings do sometimes land on shared infrastructure that also sends real mail.
Scoring files that mail in Junk, where someone can still find it. Refusing bounces
it. Turn it on if you trust the list more than you fear the bounce. `postmaster@`
and `abuse@` are never refused, so a listed sender can still reach someone about
it.

## Greylisting

`SPAM_GREYLIST=true` defers the first message on each (client network, envelope
sender, recipient) triplet with `451 4.7.1` and accepts a retry after
`SPAM_GREYLIST_DELAY` seconds (default 300), as long as the retry comes within 24
hours. A real mail server retries. Most spam software does not. Once a triplet has
passed, it is accepted without delay until it has been unused for 36 days. The
client network is the /24 for IPv4 and the /64 for IPv6, because large senders
retry from a different machine in the same pool.

It is off by default because your users pay for it. The first message from anyone
new arrives at least five minutes late, and a sign-in code can expire in that
time. These skip it:

- The null sender (`MAIL FROM:<>`): bounces and delivery reports
- Authenticated sessions, and this server delivering to itself
- Clients on private addresses
- A client network that has passed greylisting for any recipient in the last 36
  days
- A sender whose SPF passes, if their domain has passed greylisting before
- A sender whose SPF passes, if the recipient has written to them

## Correspondents

Whenever a mailbox sends mail, over SMTP submission, the webmail, or JMAP, its
recipients are remembered as that mailbox's correspondents. Each mailbox keeps its
most recent 5,000. A message to more than 100 recipients at once is not recorded,
because a mailing list is not a list of people you trust. Agent mailboxes are not
recorded either: what an agent sends may be a prompt injection's choice.

Mail from a correspondent gets −5 and skips greylisting, **but only when the sender
is authenticated**. SPF or DKIM must pass for the domain in the From header,
aligned the way DMARC aligns. Putting a known contact's address in a forged From
is the oldest phishing trick there is, and without that check this feature would
wave it straight into the inbox.

Replies are matched by address, not by `In-Reply-To`. A reply almost always comes
from someone you wrote to, so the address already covers it.
