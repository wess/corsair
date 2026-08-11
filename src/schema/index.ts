import { column, defineSchema, type RowOf } from "@atlas/db"

/**
 * Every table in one module.
 *
 * Kept together rather than split per area because the relationships are the
 * interesting part — an address belongs to a domain, a message to a folder, a
 * folder to an address — and reading them in one file is how that stays
 * obvious. `allSchemas` at the bottom is what `migrate diff` walks.
 */

const id = () => column.uuid().primaryKey().defaultRaw("gen_random_uuid()")
const now = () => column.timestamp().defaultRaw("now()")

// ------------------------------------------------------------------ accounts --

export type NotificationPrefs = {
  referrals?: boolean
  quota?: boolean
  security?: boolean
}

/**
 * A control-panel login. Distinct from an address: one user owns many domains,
 * each of which has many addresses, and an address's password is what a mail
 * client authenticates with — never this one.
 *
 * status: active | suspended | terminated
 * theme:  light | dark | lights_out
 */
export const users = defineSchema("users", {
  id: id(),
  email: column.text().unique(),
  password_hash: column.text().nullable(),
  name: column.text().nullable(),
  // Where account notices go. Deliberately separate from the sign-in email so a
  // customer can sign in with an address hosted here without losing the ability
  // to be told that this server is down.
  notifications_email: column.text().nullable(),
  status: column.text().default("active"),
  theme: column.text().default("dark"),
  totp_secret: column.text().nullable(),
  totp_enabled: column.boolean().default(false),
  backup_codes: column.json<string[]>().nullable(),
  notification_prefs: column.json<NotificationPrefs>().nullable(),
  referral_code: column.text().unique(),
  referred_by: column.uuid().nullable(),
  is_owner: column.boolean().default(false),
  // The payment provider's customer record, created lazily at first checkout.
  provider_customer_ref: column.text().nullable(),
  email_verified_at: column.timestamp().nullable(),
  terminated_at: column.timestamp().nullable(),
  created_at: now(),
  updated_at: now(),
})

export const sessions = defineSchema("sessions", {
  id: column.text().primaryKey(),
  user_id: column.uuid().ref("users", "id"),
  ip: column.text().nullable(),
  user_agent: column.text().nullable(),
  created_at: now(),
  last_used_at: column.timestamp().nullable(),
  expires_at: column.timestamp(),
  revoked_at: column.timestamp().nullable(),
})

// A referral is recorded at signup and rewarded when the referred user first
// pays, which is why the two timestamps are separate columns rather than one
// status.
export const referrals = defineSchema("referrals", {
  id: id(),
  referrer_id: column.uuid().ref("users", "id"),
  referred_id: column.uuid().ref("users", "id"),
  rewarded_at: column.timestamp().nullable(),
  reward_months: column.integer().default(1),
  created_at: now(),
})

// One-shot links: email verification, password reset, and the per-domain
// address recovery tool.
// kind: email_verify | password_reset | address_recovery
export const tokens = defineSchema("tokens", {
  id: id(),
  kind: column.text(),
  token_hash: column.text().unique(),
  user_id: column.uuid().nullable(),
  address_id: column.uuid().nullable(),
  expires_at: column.timestamp(),
  used_at: column.timestamp().nullable(),
  created_at: now(),
})

export type User = RowOf<typeof users>
export type Session = RowOf<typeof sessions>
export type Referral = RowOf<typeof referrals>
export type Token = RowOf<typeof tokens>

// ----------------------------------------------------------------- addresses --

/**
 * Everything addressable at a hosted domain.
 *
 * type: standard | alias | catchall | group
 *
 *   standard  a mailbox with a password, reachable over IMAP/POP3
 *   alias     forwards to exactly one destination, no mailbox, no password
 *   catchall  a mailbox that also receives anything unmatched in the domain
 *   group     forwards to several destinations at once
 *
 * Only standard and catchall carry a password_hash; the forwarding types have
 * nothing to log into. `local_part` is stored folded to lower case because SMTP
 * treats the domain case-insensitively and every real mail store treats the
 * local part that way too.
 */
export const addresses = defineSchema("addresses", {
  id: id(),
  domain_id: column.uuid().ref("domains", "id"),
  // Set when this mailbox *is* a control-panel account, in which case it has no
  // password of its own and every protocol verifies against the account's. Null
  // for the other people on a domain, who keep a mailbox credential and have no
  // panel login. See `authenticateAddress`.
  user_id: column.uuid().nullable(),
  local_part: column.text(),
  type: column.text().default("standard"),
  name: column.text().nullable(),
  password_hash: column.text().nullable(),
  filter_id: column.uuid().nullable(),
  // Where a self-service recovery link is sent. Must not be this address.
  recovery_address: column.text().nullable(),
  bytes_used: column.bigint().default(0n),
  // Per-address override of the plan's daily limits. Null means inherit.
  daily_in_limit: column.integer().nullable(),
  daily_out_limit: column.integer().nullable(),
  disabled: column.boolean().default(false),
  last_login_at: column.timestamp().nullable(),
  password_changed_at: column.timestamp().nullable(),
  created_at: now(),
  updated_at: now(),
})

// Where an alias or group sends its mail. One row per recipient; an alias is
// simply constrained to a single row at the API layer.
export const addressDestinations = defineSchema("address_destinations", {
  id: id(),
  address_id: column.uuid().ref("addresses", "id"),
  destination: column.text(),
  position: column.integer().default(0),
  created_at: now(),
})

export type Address = RowOf<typeof addresses>
export type AddressDestination = RowOf<typeof addressDestinations>

// ------------------------------------------------------------------- billing --

export type PlanFeatures = {
  fallback_domains?: boolean
  self_service?: boolean
  custom_filters?: boolean
  transfers?: boolean
}

/**
 * Plans are rows rather than constants so a self-hoster can price, rename, or
 * delete them without a deploy — and so an instance that charges nobody can
 * simply run one unlimited plan.
 *
 * Storage is per account, not per mailbox, matching how the quota is actually
 * enforced. Daily limits are message counts, counted from mail_log.
 */
export const plans = defineSchema("plans", {
  id: id(),
  key: column.text().unique(),
  name: column.text(),
  storage_bytes: column.bigint(),
  daily_in: column.integer(),
  daily_out: column.integer(),
  // Zero means free. Both intervals are stored so the panel can show the annual
  // discount without recomputing it.
  monthly_cents: column.integer().default(0),
  yearly_cents: column.integer().default(0),
  // The payment provider's own price identifiers, so hosted checkout can be
  // started for a plan without the panel knowing anything about the provider.
  monthly_price_ref: column.text().nullable(),
  yearly_price_ref: column.text().nullable(),
  max_domains: column.integer().nullable(),
  max_addresses: column.integer().nullable(),
  features: column.json<PlanFeatures>().default({}),
  is_trial: column.boolean().default(false),
  visible: column.boolean().default(true),
  position: column.integer().default(0),
  created_at: now(),
})

/**
 * status: trialing | active | past_due | cancelled
 *
 * `cancel_at_period_end` rather than an immediate delete: a cancelled
 * subscription keeps serving mail until the period it was paid for runs out.
 */
export const subscriptions = defineSchema("subscriptions", {
  id: id(),
  user_id: column.uuid().ref("users", "id"),
  plan_id: column.uuid().ref("plans", "id"),
  status: column.text().default("trialing"),
  interval: column.text().default("yearly"),
  current_period_start: now(),
  current_period_end: column.timestamp(),
  cancel_at_period_end: column.boolean().default(false),
  cancelled_at: column.timestamp().nullable(),
  // Months granted by the referral program, consumed before money is charged.
  credit_months: column.integer().default(0),
  provider: column.text().nullable(),
  provider_ref: column.text().nullable(),
  created_at: now(),
  updated_at: now(),
})

// status: paid | pending | refunded | failed
export const transactions = defineSchema("transactions", {
  id: id(),
  user_id: column.uuid().ref("users", "id"),
  subscription_id: column.uuid().nullable(),
  description: column.text(),
  amount_cents: column.integer(),
  currency: column.text().default("usd"),
  status: column.text().default("paid"),
  provider: column.text().nullable(),
  provider_ref: column.text().nullable(),
  invoice_number: column.text().nullable(),
  transaction_date: now(),
  created_at: now(),
})

// Card details never touch this server. Only what a payment provider hands back
// for display is stored, which is why there is no field that could hold a PAN.
export const paymentMethods = defineSchema("payment_methods", {
  id: id(),
  user_id: column.uuid().ref("users", "id"),
  brand: column.text(),
  last4: column.text(),
  exp_month: column.integer().nullable(),
  exp_year: column.integer().nullable(),
  is_default: column.boolean().default(false),
  provider: column.text().nullable(),
  provider_ref: column.text().nullable(),
  created_at: now(),
})

export const taxIds = defineSchema("tax_ids", {
  id: id(),
  user_id: column.uuid().ref("users", "id"),
  kind: column.text(),
  value: column.text(),
  country: column.text().nullable(),
  business_name: column.text().nullable(),
  address_line: column.text().nullable(),
  created_at: now(),
  updated_at: now(),
})

// Webhook deliveries, recorded so a replayed event is applied exactly once.
// Providers retry aggressively and do resend the same event.
export const paymentEvents = defineSchema("payment_events", {
  id: id(),
  provider: column.text(),
  event_ref: column.text(),
  kind: column.text(),
  payload: column.json<unknown>().nullable(),
  processed_at: column.timestamp().nullable(),
  created_at: now(),
})

export type Plan = RowOf<typeof plans>
export type PaymentEvent = RowOf<typeof paymentEvents>
export type Subscription = RowOf<typeof subscriptions>
export type Transaction = RowOf<typeof transactions>
export type PaymentMethod = RowOf<typeof paymentMethods>
export type TaxId = RowOf<typeof taxIds>

// ------------------------------------------------------------------ delivery --

/**
 * The outbound queue. One row per recipient rather than per message, because
 * recipients fail independently and retrying a whole message would redeliver to
 * the addresses that already accepted it.
 *
 * status: queued | sending | sent | deferred | failed
 */
export const deliveries = defineSchema("deliveries", {
  id: id(),
  address_id: column.uuid().nullable(),
  domain_id: column.uuid().nullable(),
  storage_key: column.text().nullable(),
  message_id: column.text().nullable(),
  mail_from: column.text(),
  rcpt_to: column.text(),
  // Cached MX host for the recipient domain, so a retry does not re-resolve.
  next_hop: column.text().nullable(),
  status: column.text().default("queued"),
  attempts: column.integer().default(0),
  max_attempts: column.integer().default(12),
  run_at: now(),
  locked_at: column.timestamp().nullable(),
  locked_by: column.text().nullable(),
  // The verbatim final SMTP reply. Operators need the original text, not a
  // paraphrase, to tell a greylist from a block.
  last_code: column.integer().nullable(),
  last_error: column.text().nullable(),
  size: column.integer().default(0),
  sent_at: column.timestamp().nullable(),
  created_at: now(),
  updated_at: now(),
})

/**
 * Every message this server accepted or emitted, one row per direction per
 * recipient. This is what the Overview charts, the per-address activity graph,
 * and the daily send limits are all counted from.
 *
 * direction: inbound | outbound
 * status:    accepted | rejected | delivered | deferred | bounced | spam
 */
export const mailLog = defineSchema("mail_log", {
  id: id(),
  user_id: column.uuid().nullable(),
  domain_id: column.uuid().nullable(),
  address_id: column.uuid().nullable(),
  direction: column.text(),
  status: column.text(),
  mail_from: column.text().nullable(),
  rcpt_to: column.text().nullable(),
  subject: column.text().nullable(),
  message_id: column.text().nullable(),
  size: column.integer().default(0),
  remote_ip: column.text().nullable(),
  remote_host: column.text().nullable(),
  spf: column.text().nullable(),
  dkim: column.text().nullable(),
  dmarc: column.text().nullable(),
  spam_score: column.real().nullable(),
  code: column.integer().nullable(),
  detail: column.text().nullable(),
  created_at: now(),
})

// A bounce we generated or received, kept so repeated failures to the same
// recipient can be suppressed rather than retried forever.
export const bounces = defineSchema("bounces", {
  id: id(),
  domain_id: column.uuid().nullable(),
  address_id: column.uuid().nullable(),
  recipient: column.text(),
  kind: column.text().default("hard"),
  code: column.integer().nullable(),
  reason: column.text().nullable(),
  created_at: now(),
})

export type Delivery = RowOf<typeof deliveries>
export type MailLogEntry = RowOf<typeof mailLog>
export type Bounce = RowOf<typeof bounces>

// ------------------------------------------------------------------- domains --

/**
 * status: pending | active | failed
 *
 * A domain is pending until every required DNS record checks out. Mail is
 * accepted for pending domains — refusing it would bounce real mail during the
 * propagation window — but sending is blocked until the domain is active, so a
 * misconfigured SPF cannot burn the IP's reputation.
 */
export const domains = defineSchema("domains", {
  id: id(),
  user_id: column.uuid().ref("users", "id"),
  name: column.text(),
  status: column.text().default("pending"),
  verification_token: column.text(),
  // Unmatched recipients are handed to this domain instead of bouncing. Null is
  // the common case.
  fallback_domain_id: column.uuid().nullable(),
  self_service_enabled: column.boolean().default(false),
  // Cached from the domain's NS records, so the setup screen knows whether a
  // one-click publish is available without re-querying every render.
  dns_provider: column.text().nullable(),
  dns_published_at: column.timestamp().nullable(),
  dmarc_policy: column.text().default("quarantine"),
  bytes_used: column.bigint().default(0n),
  verified_at: column.timestamp().nullable(),
  last_checked_at: column.timestamp().nullable(),
  created_at: now(),
  updated_at: now(),
})

/**
 * The DNS records a customer has to publish, and what we last saw when we
 * looked. Stored rather than computed so the check result survives a restart
 * and so the panel can show which single record is holding a domain back.
 *
 * purpose: verification | spf | dmarc | dkim | mta_sts | autoconfig
 *        | autodiscover | mx
 * status:  pending | ok | missing | mismatch
 */
export const domainRecords = defineSchema("domain_records", {
  id: id(),
  domain_id: column.uuid().ref("domains", "id"),
  purpose: column.text(),
  type: column.text(),
  host: column.text(),
  value: column.text(),
  priority: column.integer().nullable(),
  ttl: column.text().default("Auto"),
  required: column.boolean().default(true),
  status: column.text().default("pending"),
  observed: column.text().nullable(),
  checked_at: column.timestamp().nullable(),
  position: column.integer().default(0),
  created_at: now(),
})

/**
 * Signing keys. Three selectors exist per domain so a key can be rotated by
 * flipping `active` rather than by asking the customer to edit DNS, which they
 * will not do.
 */
export const dkimKeys = defineSchema("dkim_keys", {
  id: id(),
  domain_id: column.uuid().ref("domains", "id"),
  selector: column.text(),
  // The host the customer CNAMEs to, so the lookup resolves to us.
  cname_target: column.text(),
  private_key: column.text(),
  public_key: column.text(),
  active: column.boolean().default(false),
  position: column.integer().default(0),
  created_at: now(),
  rotated_at: column.timestamp().nullable(),
})

export type Domain = RowOf<typeof domains>
export type DomainRecord = RowOf<typeof domainRecords>
export type DkimKey = RowOf<typeof dkimKeys>

// ------------------------------------------------------------------- filters --

/**
 * A Sieve script (RFC 5228). Filters belong to the account, not to an address,
 * so one script can be attached to many mailboxes — which is the whole reason
 * they are a separate screen rather than a field on the address.
 *
 * `size` is stored because the list view sorts on it and computing it per row
 * from the script text is wasted work.
 */
export const filters = defineSchema("filters", {
  id: id(),
  user_id: column.uuid().ref("users", "id"),
  name: column.text(),
  script: column.text(),
  size: column.integer().default(0),
  // Set when the script last failed to compile, so the panel can show why a
  // filter is not running instead of silently ignoring it.
  compile_error: column.text().nullable(),
  created_at: now(),
  updated_at: now(),
})

export type Filter = RowOf<typeof filters>

// ---------------------------------------------------------------------- mail --

/**
 * An IMAP folder.
 *
 * `uid_validity` is stamped once at creation and must never change while the
 * folder keeps its identity — a client that sees it change discards its entire
 * cache for that folder. `uid_next` is handed out under a row lock so two
 * concurrent deliveries cannot take the same UID.
 *
 * special_use is the RFC 6154 attribute without the backslash: inbox, sent,
 * drafts, trash, junk, archive, or null for a user-created folder.
 */
export const folders = defineSchema("folders", {
  id: id(),
  address_id: column.uuid().ref("addresses", "id"),
  // Full hierarchical path with "/" as the delimiter, e.g. "Projects/Corsair".
  name: column.text(),
  special_use: column.text().nullable(),
  uid_validity: column.bigint(),
  uid_next: column.bigint().default(1n),
  highest_modseq: column.bigint().default(1n),
  subscribed: column.boolean().default(true),
  created_at: now(),
  updated_at: now(),
})

export type Envelope = {
  date: string | null
  subject: string | null
  from: string[]
  sender: string[]
  reply_to: string[]
  to: string[]
  cc: string[]
  bcc: string[]
  in_reply_to: string | null
  message_id: string | null
}

/**
 * One delivered message.
 *
 * The raw MIME lives in object storage under `storage_key` (or inline in
 * `message_blobs` when no bucket is configured); this row holds only what IMAP
 * needs to answer FETCH, SEARCH, and SORT without pulling the body back.
 *
 * Flags are a JSON array rather than a Postgres array because @atlas/db has no
 * array column type, and jsonb containment indexes the membership test we
 * actually run.
 */
export const messages = defineSchema("messages", {
  id: id(),
  folder_id: column.uuid().ref("folders", "id"),
  address_id: column.uuid().ref("addresses", "id"),
  uid: column.bigint(),
  modseq: column.bigint().default(1n),
  // \Seen \Answered \Flagged \Deleted \Draft plus any keyword the client sets.
  flags: column.json<string[]>().default([]),
  internal_date: now(),
  size: column.integer(),
  storage_key: column.text().nullable(),
  // Denormalised header fields. Kept as columns because SEARCH and the panel's
  // activity views filter on them constantly.
  message_id: column.text().nullable(),
  in_reply_to: column.text().nullable(),
  thread_id: column.text().nullable(),
  subject: column.text().nullable(),
  from_address: column.text().nullable(),
  to_addresses: column.json<string[]>().nullable(),
  cc_addresses: column.json<string[]>().nullable(),
  envelope: column.json<Envelope>().nullable(),
  body_structure: column.json<unknown>().nullable(),
  snippet: column.text().nullable(),
  // Full-text search target, maintained alongside the row.
  search_text: column.text().nullable(),
  has_attachments: column.boolean().default(false),
  spam_score: column.real().nullable(),
  expunged_at: column.timestamp().nullable(),
  created_at: now(),
})

// Raw MIME when no object-storage bucket is configured. Splitting it out keeps
// the messages table narrow, which matters because every IMAP command touches
// it and none of them want the body.
export const messageBlobs = defineSchema("message_blobs", {
  message_id: column.uuid().primaryKey().ref("messages", "id"),
  data: column.text(),
  created_at: now(),
})

// A message removed from a folder, remembered only so IMAP QRESYNC can tell a
// reconnecting client which UIDs disappeared while it was away.
export const messageTombstones = defineSchema("message_tombstones", {
  id: id(),
  folder_id: column.uuid().ref("folders", "id"),
  uid: column.bigint(),
  modseq: column.bigint(),
  created_at: now(),
})

export type Folder = RowOf<typeof folders>
export type Message = RowOf<typeof messages>
export type MessageBlob = RowOf<typeof messageBlobs>
export type MessageTombstone = RowOf<typeof messageTombstones>

// ----------------------------------------------------------------------- ops --

/**
 * The work queue every worker polls.
 *
 * kind: domain.verify | transfer.run | quota.recompute | retention.sweep
 *     | dkim.rotate | notify.send
 * status: pending | running | done | failed
 */
export const jobs = defineSchema("jobs", {
  id: id(),
  user_id: column.uuid().nullable(),
  kind: column.text(),
  payload: column.json<Record<string, unknown>>(),
  status: column.text().default("pending"),
  run_at: now(),
  attempts: column.integer().default(0),
  max_attempts: column.integer().default(5),
  locked_at: column.timestamp().nullable(),
  locked_by: column.text().nullable(),
  last_error: column.text().nullable(),
  created_at: now(),
  updated_at: now(),
})

// Shape required by @atlas/security#createDbRateLimit.
export const rateLimits = defineSchema("rate_limits", {
  bucket: column.text().primaryKey(),
  count: column.integer(),
  window_started_at: column.timestamp(),
})

// Shape required by @atlas/security#createAuditLogger.
export const auditEvents = defineSchema("audit_events", {
  id: column.serial().primaryKey(),
  user_id: column.text().nullable(),
  event: column.text(),
  metadata: column.text().nullable(),
  ip: column.text().nullable(),
  user_agent: column.text().nullable(),
  created_at: now(),
})

/**
 * Failed authentication attempts against SMTP, IMAP, and POP3, keyed by the
 * remote address. The mail listeners are on the public internet and will be
 * brute-forced from the first hour; this is what the ban check reads.
 */
export const authFailures = defineSchema("auth_failures", {
  id: id(),
  ip: column.text(),
  protocol: column.text(),
  username: column.text().nullable(),
  created_at: now(),
})

export const bans = defineSchema("bans", {
  ip: column.text().primaryKey(),
  reason: column.text().nullable(),
  expires_at: column.timestamp(),
  created_at: now(),
})

export type Job = RowOf<typeof jobs>
export type AuthFailure = RowOf<typeof authFailures>
export type Ban = RowOf<typeof bans>

// ----------------------------------------------------------------- transfers --

/**
 * An IMAP-to-IMAP migration from a customer's previous host.
 *
 * status: queued | running | done | failed | cancelled
 *
 * The source password is encrypted at rest and cleared the moment the transfer
 * reaches a terminal state — it is someone else's credential and there is no
 * reason to keep it once the copy is finished.
 */
export const transfers = defineSchema("transfers", {
  id: id(),
  user_id: column.uuid().ref("users", "id"),
  address_id: column.uuid().ref("addresses", "id"),
  server: column.text(),
  port: column.integer().default(993),
  secure: column.boolean().default(true),
  username: column.text(),
  password_enc: column.text().nullable(),
  message_limit: column.integer().nullable(),
  size_limit: column.bigint().nullable(),
  // Only copy messages whose INTERNALDATE is at or after this instant.
  newer_than: column.timestamp().nullable(),
  status: column.text().default("queued"),
  folders_total: column.integer().default(0),
  folders_done: column.integer().default(0),
  messages_total: column.integer().default(0),
  messages_done: column.integer().default(0),
  bytes_done: column.bigint().default(0n),
  last_error: column.text().nullable(),
  started_at: column.timestamp().nullable(),
  finished_at: column.timestamp().nullable(),
  created_at: now(),
  updated_at: now(),
})

export type Transfer = RowOf<typeof transfers>

// ------------------------------------------------------------- webhooks --

/**
 * An outbound event hook.
 *
 * status: enabled | disabled
 *
 * A hook with no `domain_id` receives events for every domain on the account;
 * one with a domain receives only that domain's. Both are wanted — an operator
 * watching their whole instance, and a customer wiring up one domain.
 */
export const webhooks = defineSchema("webhooks", {
  id: id(),
  user_id: column.uuid().ref("users", "id"),
  domain_id: column.uuid().nullable(),
  url: column.text(),
  description: column.text().nullable(),
  events: column.json<string[]>().default([]),
  status: column.text().default("enabled"),
  signing_secret: column.text(),
  disabled_reason: column.text().nullable(),
  consecutive_failures: column.integer().default(0),
  last_success_at: column.timestamp().nullable(),
  created_at: now(),
  updated_at: now(),
})

/**
 * One row per (event, endpoint).
 *
 * The id is a `msg_<base62>` string rather than a UUID because it is the
 * idempotency key the receiver sees, and it travels in a header — a receiver
 * that stores it to deduplicate retries wants something short and opaque.
 *
 * status: pending | delivered | failed | exhausted
 */
export const webhookEvents = defineSchema("webhook_events", {
  id: column.text().primaryKey(),
  user_id: column.uuid().nullable(),
  webhook_id: column.uuid().ref("webhooks", "id"),
  type: column.text(),
  payload: column.json<Record<string, unknown>>(),
  status: column.text().default("pending"),
  attempts: column.integer().default(0),
  next_attempt_at: column.timestamp().nullable(),
  delivered_at: column.timestamp().nullable(),
  created_at: now(),
})

export const webhookAttempts = defineSchema("webhook_attempts", {
  id: id(),
  webhook_event_id: column.text().ref("webhook_events", "id"),
  webhook_id: column.uuid(),
  http_status_code: column.integer().nullable(),
  response: column.text().nullable(),
  error: column.text().nullable(),
  duration_ms: column.integer().nullable(),
  sent_at: now(),
})

export type Webhook = RowOf<typeof webhooks>
export type WebhookEvent = RowOf<typeof webhookEvents>
export type WebhookAttempt = RowOf<typeof webhookAttempts>

// ------------------------------------------------------------------- all --

/**
 * Every table above, for `migrate diff` and introspection.
 *
 * Listed explicitly rather than discovered: a table missing from this array
 * is a table `diff` will not notice has drifted, and an explicit list fails
 * loudly at the type level when one is renamed.
 */
export const allSchemas = [
  addressDestinations,
  addresses,
  auditEvents,
  authFailures,
  bans,
  bounces,
  deliveries,
  dkimKeys,
  domainRecords,
  domains,
  filters,
  folders,
  jobs,
  mailLog,
  messageBlobs,
  messageTombstones,
  messages,
  paymentEvents,
  paymentMethods,
  plans,
  rateLimits,
  referrals,
  sessions,
  subscriptions,
  taxIds,
  tokens,
  transactions,
  transfers,
  users,
  webhookAttempts,
  webhookEvents,
  webhooks,
]
