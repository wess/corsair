import { defineConfig, env } from "@wess/atlas/config"

const bool = (v: string) => v === "true" || v === "1" || v === "yes"
const list = (v: string) =>
  v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

export const config = defineConfig({
  databaseUrl: env("DATABASE_URL", {
    default: "postgres://corsair:corsair@localhost:55433/corsair",
  }),
  dbPool: env("DB_POOL_SIZE", { parse: Number, default: "10" }),
  jwtSecret: env("JWT_SECRET", { default: "corsair-dev-secret-change-me" }),
  port: env("PORT", { parse: Number, default: "3000" }),

  // The interface the HTTP tier binds. It stays on all interfaces by default
  // because a container that binds loopback is a container nothing can reach.
  // An install with a reverse proxy on the same box should set 127.0.0.1: the
  // panel, the webmail, and JMAP have no business being reachable except
  // through the proxy that terminates TLS for them.
  host: env("HOST", { default: "0.0.0.0" }),

  publicUrl: env("PUBLIC_URL", { default: "http://localhost:3000" }),
  signups: env("SIGNUPS", { default: "open" }),

  // The name this server gives in EHLO and stamps into Received headers.
  hostname: env("CORSAIR_HOSTNAME", { default: "mail.corsair.local" }),

  // The public names of this installation, quoted back to customers on the DNS
  // Setup screen. They are configuration rather than constants because a
  // self-hoster's MX is not ours.
  mail: {
    mx: env("MAIL_MX_HOST", { default: "mx1.corsair.local" }),
    smtp: env("MAIL_SMTP_HOST", { default: "smtp.corsair.local" }),
    imap: env("MAIL_IMAP_HOST", { default: "imap.corsair.local" }),
    pop: env("MAIL_POP_HOST", { default: "pop.corsair.local" }),
    spf: env("MAIL_SPF_HOST", { default: "spf.corsair.local" }),
    autoconfig: env("MAIL_AUTOCONFIG_HOST", { default: "autoconfig.corsair.local" }),
    autodiscover: env("MAIL_AUTODISCOVER_HOST", { default: "autodiscover.corsair.local" }),
    // enable only after the HTTPS proxy can serve customer webmail names
    webmail: env("MAIL_WEBMAIL_HOST", { default: "" }),
    dkimHosts: env("MAIL_DKIM_HOSTS", {
      parse: list,
      default: "dkim-1.corsair.local,dkim-2.corsair.local,dkim-3.corsair.local",
    }),
  },

  /**
   * Automatic DKIM rotation (`src/dkimrotate`). Off by default: a rotation needs
   * the operator's DNS to publish a new TXT record, and an install that does
   * that by hand should not find a cycle started under it. With 0 the job still
   * advances a rotation someone began with `bun run dkim rotate`.
   */
  dkim: {
    rotateDays: env("DKIM_ROTATE_DAYS", { parse: Number, default: "0" }),
    // Resolver caches hold the old answer for up to the record's TTL; 48 hours
    // outlasts every TTL worth worrying about.
    soakHours: env("DKIM_SOAK_HOURS", { parse: Number, default: "48" }),
    // Mail already in flight was signed with the old key and may be verified late.
    retireDays: env("DKIM_RETIRE_DAYS", { parse: Number, default: "7" }),
  },

  smtp: {
    enabled: env("SMTP_ENABLED", { parse: bool, default: "true" }),
    mxPort: env("SMTP_MX_PORT", { parse: Number, default: "2525" }),
    submissionPort: env("SMTP_SUBMISSION_PORT", { parse: Number, default: "2587" }),
    submissionTlsPort: env("SMTP_SUBMISSION_TLS_PORT", { parse: Number, default: "2465" }),
    /**
     * Where the two *plaintext-capable* listeners bind — the MX port and
     * submission-with-STARTTLS. Set to 127.0.0.1 when the terminator is in
     * front of them: it holds 25 and 587, and a backend still answering on a
     * public address would be a way to talk to this server without TLS.
     * Submission on 465 is unaffected; it has no plaintext phase.
     */
    bind: env("SMTP_BIND", { default: "0.0.0.0" }),
    /**
     * True when something in front of these listeners terminates STARTTLS for
     * them — the terminator in `engine/`. It changes nothing about what this
     * process does; it changes what the server tells the world it supports.
     */
    startTlsFronted: env("SMTP_STARTTLS_FRONTED", { parse: bool, default: "false" }),
    /**
     * The ports clients are told to use, which stop matching the ports this
     * process listens on the moment a terminator is in front: it holds 587
     * while Corsair listens on 2587. Autoconfig, autodiscover, and the panel
     * describe the server to somebody outside it, so they must name the port
     * that somebody outside can reach. Default to the listening ports, which is
     * correct whenever nothing is in front.
     */
    publicSubmissionPort: env("SMTP_PUBLIC_SUBMISSION_PORT", {
      parse: Number,
      default: process.env.SMTP_SUBMISSION_PORT ?? "2587",
    }),
    publicSubmissionTlsPort: env("SMTP_PUBLIC_SUBMISSION_TLS_PORT", {
      parse: Number,
      default: process.env.SMTP_SUBMISSION_TLS_PORT ?? "2465",
    }),
    /**
     * Peers allowed to speak XCLIENT and so to declare which address a session
     * is really coming from. Empty by default — the command is refused outright
     * unless an operator has put a proxy in front and named it here.
     */
    trustedProxies: env("SMTP_TRUSTED_PROXIES", { parse: list, default: "" }),
  },

  arc: {
    /**
     * Sealers whose passing ARC chain overrides a DMARC failure: a forwarder or
     * list this installation's users really receive through. Empty by default,
     * because anyone can seal and the override is worth only what the operator
     * knows about who is sealing.
     */
    trustedSealers: env("ARC_TRUSTED_SEALERS", { parse: list, default: "" }),
  },

  // Inbound spam handling on the MX path. See src/smtp/spam for the philosophy;
  // everything here feeds its score except the two switches that defer or refuse.
  spam: {
    // IP blocklists checked against the connecting client. Empty disables.
    dnsbl: env("SPAM_DNSBL", { parse: list, default: "zen.spamhaus.org" }),
    // Domain blocklists checked against the sender's domains and body links.
    uribl: env("SPAM_URIBL", { parse: list, default: "dbl.spamhaus.org" }),
    /**
     * Refuse at RCPT when the client is on an SBL, CSS, DROP or XBL list rather
     * than only scoring it. Off by default: the listing is a third party's
     * judgement, and an operator should choose to let it bounce mail.
     */
    dnsblReject: env("SPAM_DNSBL_REJECT", { parse: bool, default: "false" }),
    // Resolvers for blocklist queries. Spamhaus refuses public and cloud
    // resolvers, so a production install wants a local recursive one here.
    resolver: env("SPAM_RESOLVER", { parse: list, default: "" }),
    // Off by default: it delays first-contact mail and people notice.
    greylist: env("SPAM_GREYLIST", { parse: bool, default: "false" }),
    greylistDelay: env("SPAM_GREYLIST_DELAY", { parse: Number, default: "300" }),
  },

  imap: {
    enabled: env("IMAP_ENABLED", { parse: bool, default: "true" }),
    port: env("IMAP_PORT", { parse: Number, default: "2143" }),
    tlsPort: env("IMAP_TLS_PORT", { parse: Number, default: "2993" }),
  },

  pop3: {
    enabled: env("POP3_ENABLED", { parse: bool, default: "true" }),
    port: env("POP3_PORT", { parse: Number, default: "2110" }),
    tlsPort: env("POP3_TLS_PORT", { parse: Number, default: "2995" }),
  },

  managesieve: {
    enabled: env("MANAGESIEVE_ENABLED", { parse: bool, default: "true" }),
    port: env("MANAGESIEVE_PORT", { parse: Number, default: "4190" }),
  },

  tls: {
    certPath: env("TLS_CERT_PATH", { default: "" }),
    keyPath: env("TLS_KEY_PATH", { default: "" }),
  },

  // The built-in ACME client, for an install with no certbot and no reverse
  // proxy holding a certificate. Off by default: with it on, TLS_CERT_PATH and
  // TLS_KEY_PATH are ignored. See src/acme.
  acme: {
    enabled: env("ACME", { parse: (v) => v === "on" || bool(v), default: "off" }),
    email: env("ACME_EMAIL", { default: "" }),
    agreeTos: env("ACME_AGREE_TOS", { parse: bool, default: "false" }),
    domains: env("ACME_DOMAINS", {
      parse: list,
      default: process.env.CORSAIR_HOSTNAME ?? "mail.corsair.local",
    }),
    directory: env("ACME_DIRECTORY", {
      default: "https://acme-v02.api.letsencrypt.org/directory",
    }),
    dir: env("ACME_DIR", { default: "./data/acme" }),
    // 0 = no listener of its own; port 80 must then reach PORT some other way.
    httpPort: env("ACME_HTTP_PORT", { parse: Number, default: "0" }),
  },

  delivery: {
    transport: env("DELIVERY_TRANSPORT", { default: "console" }),
    relay: {
      host: env("SMTP_RELAY_HOST", { default: "" }),
      port: env("SMTP_RELAY_PORT", { parse: Number, default: "587" }),
      user: env("SMTP_RELAY_USER", { default: "" }),
      pass: env("SMTP_RELAY_PASS", { default: "" }),
      secure: env("SMTP_RELAY_SECURE", { default: "starttls" }),
    },
    // DANE for direct MX delivery. `auto` turns it on only when the resolver is
    // seen to validate at startup; see `src/dane`. The resolver is `host` or
    // `host:port` (`[v6]:port`), and defaults to resolv.conf's first nameserver.
    dane: {
      mode: env("DANE", { default: "auto" }),
      resolver: env("DANE_RESOLVER", { default: "" }),
      trustRemoteResolver: env("DANE_TRUST_REMOTE_RESOLVER", { parse: bool, default: "false" }),
    },
  },

  storage: {
    bucket: env("STORAGE_BUCKET", { default: "" }),
    region: env("STORAGE_REGION", { default: "nyc3" }),
    endpoint: env("STORAGE_ENDPOINT", { default: "" }),
    accessKeyId: env("STORAGE_ACCESS_KEY_ID", { default: "" }),
    secretAccessKey: env("STORAGE_SECRET_ACCESS_KEY", { default: "" }),
    prefix: env("STORAGE_PREFIX", { default: "corsair" }),
  },

  worker: {
    concurrency: env("WORKER_CONCURRENCY", { parse: Number, default: "8" }),
    pollMs: env("WORKER_POLL_MS", { parse: Number, default: "1000" }),
  },

  // Aggregate reports this server sends about the mail it receives (DMARC,
  // RFC 7489) and the TLS it negotiates when sending (RFC 8460). Off means no
  // outcomes are recorded either, not just that nothing is mailed.
  reports: {
    dmarcSend: env("DMARC_REPORTS_SEND", { parse: bool, default: "true" }),
    tlsSend: env("TLSRPT_SEND", { parse: bool, default: "true" }),
    // Reports of each kind sent per UTC day. Every domain that publishes `rua`
    // and mailed us yesterday is one report, so a server receiving from a
    // great many domains would otherwise send that many messages each morning.
    dailyCap: env("REPORTS_DAILY_CAP", { parse: Number, default: "1000" }),
    // Empty means `noreply-dmarc@<CORSAIR_HOSTNAME>`.
    from: env("REPORTS_FROM", { default: "" }),
  },

  // Card details never reach this server; these only let it talk to the
  // provider's API and verify its webhooks. Leave them empty to run unmetered.
  payments: {
    stripeSecretKey: env("STRIPE_SECRET_KEY", { default: "" }),
    stripeWebhookSecret: env("STRIPE_WEBHOOK_SECRET", { default: "" }),
    /**
     * Nothing is charged and every plan is free to choose.
     *
     * For running a beta before billing is wired up. Without it, a server with
     * no payment provider sends anyone who picks a paid plan into a dead end:
     * "add a payment method" leads to "no payment provider is configured".
     * Prices stay visible on purpose — people should see what the thing will
     * cost — but the panel says plainly that this instance is not charging.
     */
    beta: env("BILLING_BETA", { parse: bool, default: "false" }),
  },

  // Webhook endpoints on private or loopback addresses are refused by default:
  // the customer supplies the URL and this server fetches it, which is a
  // server-side request forgery primitive. An operator running Corsair and its
  // consumers on the same private network can opt back in.
  webhookAllowPrivate: env("WEBHOOK_ALLOW_PRIVATE", { parse: bool, default: "false" }),
  transferAllowPrivate: env("TRANSFER_ALLOW_PRIVATE", { parse: bool, default: "false" }),

  rateLimitPerSecond: env("RATE_LIMIT_PER_SECOND", { parse: Number, default: "10" }),
  // 25 MB, the limit the large providers apply to what they will accept. The
  // pipeline holds several copies of a message at once (the buffer, the
  // normalised text, a parse, the DKIM canonicalisation, the stored copy), so on a
  // 1 GB machine one 50 MB message peaked near 900 MB.
  maxMessageBytes: env("MAX_MESSAGE_BYTES", { parse: Number, default: "26214400" }),
  trustedProxies: env("TRUSTED_PROXIES", { default: "" }),
})

export type Config = typeof config
