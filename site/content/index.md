---
title: Corsair
description: Self-hostable email hosting. SMTP, IMAP, POP3, JMAP, webmail, and a control panel in one Bun process backed by PostgreSQL.
layout: home
---

```raw
<section class="hero">
  {{starburst}}
  <div class="hero-inner">
    <p class="eyebrow">Open source mail server + control panel</p>
    <h1>Run your own <em>mail</em>. On your own machine.</h1>
    <p class="lede">
      Corsair is the mail server and the panel that manages it. Add a domain, publish the
      records it prints, create a mailbox, and point any client at it. One process,
      PostgreSQL, and a bucket.
    </p>
    <div class="actions">
      <a class="btn btn-primary" href="docs/quickstart.html">Start in ten minutes</a>
      <a class="btn" href="docs/tutorials/first-server.html">Build a real server</a>
      <a class="btn" href="https://github.com/wess/corsair" rel="noopener">Read the source</a>
    </div>
  </div>
</section>

<section class="band">
  <div class="band-inner split">
    <div>
      <p class="eyebrow">What actually happens</p>
      <h2>A message arrives and four protocols can already see it</h2>
      <p>
        Corsair checks SPF, verifies the DKIM signature, applies the sender's DMARC policy,
        scores the message, runs the recipient's filter, and files it. There is one copy of
        the mail and no synchronisation step, so IMAP, JMAP, POP3, and the webmail are all
        looking at the same row a moment later.
      </p>
      <p>
        <a href="docs/architecture.html">How the pieces fit together →</a>
      </p>
    </div>
    <div class="terminal">
<pre><b>220</b> mail.example.com Corsair ESMTP ready
<i>EHLO sender.example.net</i>
<b>250</b>-mail.example.com
<b>250</b>-STARTTLS
<b>250</b>-8BITMIME
<b>250</b> SIZE 52428800
<i>MAIL FROM:&lt;sam@sender.example.net&gt;</i>
<b>250</b> 2.1.0 Sender OK
<i>RCPT TO:&lt;you+receipts@example.com&gt;</i>
<b>250</b> 2.1.5 Recipient OK
<i>DATA</i>
<b>354</b> Start mail input; end with &lt;CRLF&gt;.&lt;CRLF&gt;
<i>...</i>
<b>250</b> 2.0.0 Message accepted
     spf=pass dkim=pass dmarc=pass
     filed → Receipts (uid 4192)</pre>
    </div>
  </div>
</section>

<section class="band band-tint">
  <div class="band-inner">
    <div class="band-head">
      <p class="eyebrow">Specification</p>
      <h2>Everything a mail host does, in one binary</h2>
      <p>No per-seat pricing, because the cost of a mailbox is disk and bandwidth.</p>
    </div>
    <div class="grid">
      <article class="plate">
        <p class="plate-label">Receiving</p>
        <h3>MX on port 25</h3>
        <p>
          SPF, DKIM verification, DMARC, spam scoring, and Sieve filtering on the delivery
          path. Unmatched recipients fall through to sub-addressing, then a catch-all, then a
          fallback domain.
        </p>
      </article>
      <article class="plate">
        <p class="plate-label">Sending</p>
        <h3>Submission on 587 and 465</h3>
        <p>
          The From address is proven to belong to the caller, the message is DKIM-signed, a
          copy is filed in Sent, and delivery retries with backoff for five days.
        </p>
      </article>
      <article class="plate">
        <p class="plate-label">Reading</p>
        <h3>IMAP, JMAP, POP3, webmail</h3>
        <p>
          IMAP4rev1 with IDLE, MOVE, SORT, and UIDPLUS. JMAP per RFC 8620 and 8621. POP3 for
          the clients that still want it. A three-pane webmail client at
          <code>/webmail</code>.
        </p>
      </article>
      <article class="plate">
        <p class="plate-label">Addresses</p>
        <h3>Four kinds, one domain</h3>
        <p>
          Mailboxes with a password, aliases that forward, groups that fan out, and a
          catch-all. Forwarded mail is SRS-rewritten so it survives the next hop's SPF check.
        </p>
      </article>
      <article class="plate">
        <p class="plate-label">DNS</p>
        <h3>Published for you</h3>
        <p>
          Corsair detects your provider from the NS records and, given a token, writes all
          ten records itself. The token is used once and never stored. Manual setup, a live
          checker, and a zone-file export are always there too.
        </p>
      </article>
      <article class="plate">
        <p class="plate-label">Events</p>
        <h3>Signed webhooks</h3>
        <p>
          A POST to your endpoint when mail arrives, bounces, or is filed as spam. Standard
          Webhooks signing, so the verification library you already have works unchanged.
        </p>
      </article>
    </div>
  </div>
</section>

<section class="band">
  <div class="band-inner">
    <div class="band-head">
      <p class="eyebrow">By the numbers</p>
      <h2>Small on purpose</h2>
    </div>
    <div class="stats">
      <div class="stat"><span class="stat-value">1</span><span class="stat-label">Process</span></div>
      <div class="stat"><span class="stat-value">5</span><span class="stat-label">Protocols</span></div>
      <div class="stat"><span class="stat-value">11</span><span class="stat-label">DNS records</span></div>
      <div class="stat"><span class="stat-value">2</span><span class="stat-label">Dependencies</span></div>
      <div class="stat"><span class="stat-value">0</span><span class="stat-label">Telemetry calls</span></div>
    </div>
  </div>
</section>

<section class="band band-tint">
  <div class="band-inner split">
    <div>
      <p class="eyebrow">Read this part first</p>
      <h2>Running mail is four things that are not code</h2>
      <p>
        Corsair will not pretend otherwise. Before any of this is reachable mail you need a
        static IP whose PTR record matches your hostname, port 25 unblocked outbound, a real
        TLS certificate, and permission to bind the privileged ports.
      </p>
      <p>
        If you cannot get port 25, that is fine — point Corsair at a smarthost and it relays
        instead. Everything else works the same.
      </p>
      <p><a href="docs/prerequisites.html">The prerequisites, in detail →</a></p>
    </div>
    <div>
      <article class="plate">
        <p class="plate-label">Ten minutes</p>
        <h3>Try it on your laptop first</h3>
```

```sh
git clone https://github.com/wess/corsair
cd corsair
bun install && cp .env.example .env
bun run db:up && bun run migrate && bun run seed
bun run dev
```

```raw
        <p>
          Unprivileged ports, mail printed to the console instead of sent, and a panel at
          <code>localhost:3000/app</code>. Nothing leaves the machine.
        </p>
      </article>
    </div>
  </div>
</section>

<section class="band">
  <div class="band-inner">
    <div class="band-head">
      <p class="eyebrow">Documentation</p>
      <h2>Learn it end to end</h2>
      <p>Setup, operation, and every protocol surface — written to be read in order or searched.</p>
    </div>
    <div class="grid">
      <article class="plate">
        <p class="plate-label">Tutorials</p>
        <h3>Follow a build</h3>
        <p><a href="docs/tutorials/first-server.html">Your first production server</a> takes a
        blank VPS to delivered mail. Then migrate a domain off Google, wire up webhooks, or
        set up a household.</p>
      </article>
      <article class="plate">
        <p class="plate-label">Operations</p>
        <h3>Keep it running</h3>
        <p><a href="docs/backups.html">Backups</a>,
        <a href="docs/monitoring.html">monitoring</a>,
        <a href="docs/upgrading.html">upgrades</a>, and a
        <a href="docs/troubleshooting.html">symptom-first troubleshooting guide</a>.</p>
      </article>
      <article class="plate">
        <p class="plate-label">Reference</p>
        <h3>Look it up</h3>
        <p>Every <a href="docs/configuration.html">environment variable</a>,
        <a href="docs/api.html">HTTP endpoint</a>,
        <a href="docs/imap.html">IMAP command</a>, and
        <a href="docs/smtp-errors.html">reply code</a>.</p>
      </article>
    </div>
  </div>
</section>
```
