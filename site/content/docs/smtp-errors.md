---
title: SMTP error lookup
description: What an SMTP reply code actually means, and whether you need to act on it.
section: reference
order: 9
short: SMTP errors
eyebrow: Reference
---

# SMTP error lookup

The first digit is what matters. **4xx is temporary** — the sender will retry,
often for days. **5xx is permanent** — the message bounces.

Paste a code or part of a message to find it.

```raw
<div class="lookup">
  <input id="lookup" type="search" placeholder="550, quota, greylisting…" aria-label="Filter SMTP codes" autocomplete="off" />
  <p class="lookup-empty" id="lookup-empty" hidden>Nothing matches that. The code may be specific to the receiving server — the text of its reply is usually the better clue.</p>
</div>
<script>
  // Filters every row of every table on the page. The tables are the data;
  // this only hides rows, so the page still works with scripting disabled.
  (function () {
    var input = document.getElementById("lookup");
    var empty = document.getElementById("lookup-empty");
    if (!input) return;
    input.addEventListener("input", function () {
      // Queried per keystroke rather than once at load: this script is inline
      // and runs while the document is still parsing, so the tables below it do
      // not exist yet.
      var rows = Array.prototype.slice.call(document.querySelectorAll("tbody tr"));
      var q = input.value.trim().toLowerCase();
      var shown = 0;
      rows.forEach(function (row) {
        var hit = !q || row.textContent.toLowerCase().indexOf(q) !== -1;
        row.hidden = !hit;
        if (hit) shown++;
      });
      empty.hidden = shown !== 0;
    });
  })();
</script>
```

## Codes Corsair returns

| Code | Meaning | What to do |
| --- | --- | --- |
| 421 | Too many errors, or too many failed logins from this address | The IP is temporarily banned. Wait an hour. |
| 450 | Mailbox temporarily unavailable | Retry. |
| 451 | Daily sending limit reached | The account is over its outbound allowance for the day. |
| 452 | Storage quota exceeded, or recipient's daily inbound limit reached | Free space or upgrade; the sender will retry. |
| 501 | Malformed address or syntax | The sending client has a bug. |
| 503 | Commands out of order | Usually a client that pipelined without checking for support. |
| 530 | Authentication required | Submission needs AUTH. Check the client is using 587 or 465, not 25. |
| 535 | Credentials invalid | Wrong mailbox password. Note this is not the panel password. |
| 538 | Encryption required | The client tried to authenticate before STARTTLS. |
| 550 | No such user, or relay denied | The address does not exist here, or the domain is not hosted here. |
| 552 | Message too large | Over `MAX_MESSAGE_BYTES`. |
| 554 | No valid recipients | Every recipient was rejected. |

## Codes you will see from others

| Code | Usually means |
| --- | --- |
| 421 4.7.0 | Rate-limited by the receiver. Slow down; this is not an error in your configuration. |
| 450 4.2.0 | Greylisting. The first attempt is always refused; the retry is accepted. Nothing to fix. |
| 550 5.7.1 | Blocked on policy — reputation, SPF, or DMARC. The text usually names which. |
| 550 5.7.26 | Unauthenticated: no aligned SPF or DKIM. Your DNS is wrong or incomplete. |
| 554 5.7.1 | Listed on a blocklist. The text usually names it. |

## Reading a bounce

A bounce carries three parts: a human-readable explanation, a machine-readable
`message/delivery-status` report, and the original headers. The
`Diagnostic-Code` line in the middle part is the remote server's verbatim reply
— that is the one to act on, not the summary at the top.
