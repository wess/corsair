import { defineConfig, env } from "@atlas/config"

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
    dkimHosts: env("MAIL_DKIM_HOSTS", {
      parse: list,
      default: "dkim-1.corsair.local,dkim-2.corsair.local,dkim-3.corsair.local",
    }),
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
     * Peers allowed to speak XCLIENT and so to declare which address a session
     * is really coming from. Empty by default — the command is refused outright
     * unless an operator has put a proxy in front and named it here.
     */
    trustedProxies: env("SMTP_TRUSTED_PROXIES", { parse: list, default: "" }),
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

  tls: {
    certPath: env("TLS_CERT_PATH", { default: "" }),
    keyPath: env("TLS_KEY_PATH", { default: "" }),
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

  // Card details never reach this server; these only let it talk to the
  // provider's API and verify its webhooks. Leave them empty to run unmetered.
  payments: {
    stripeSecretKey: env("STRIPE_SECRET_KEY", { default: "" }),
    stripeWebhookSecret: env("STRIPE_WEBHOOK_SECRET", { default: "" }),
  },

  // Webhook endpoints on private or loopback addresses are refused by default:
  // the customer supplies the URL and this server fetches it, which is a
  // server-side request forgery primitive. An operator running Corsair and its
  // consumers on the same private network can opt back in.
  webhookAllowPrivate: env("WEBHOOK_ALLOW_PRIVATE", { parse: bool, default: "false" }),

  rateLimitPerSecond: env("RATE_LIMIT_PER_SECOND", { parse: Number, default: "10" }),
  maxMessageBytes: env("MAX_MESSAGE_BYTES", { parse: Number, default: "52428800" }),
  trustedProxies: env("TRUSTED_PROXIES", { default: "" }),
})

export type Config = typeof config
