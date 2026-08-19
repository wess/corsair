import { num } from "../db/index.ts"
import type { Entitlement, Usage } from "../plans/index.ts"
import type {
  Address,
  DkimKey,
  Domain,
  DomainRecord,
  Filter,
  Message,
  PaymentMethod,
  Plan,
  Subscription,
  TaxId,
  Transaction,
  Transfer,
  User,
} from "../schema/index.ts"

/**
 * Every response shape lives here so the panel and any API client see one
 * definition. Nothing that is a secret — password hashes, DKIM private keys,
 * TOTP secrets, stored provider tokens — has a field in any of these.
 */

export const userObject = (
  user: User,
): {
  object: "user"
  id: string
  email: string
  name: string | null
  notifications_email: string | null
  status: string
  theme: string
  totp_enabled: boolean
  is_owner: boolean
  referral_code: string
  notification_prefs: Record<string, boolean>
  created_at: string
} => ({
  object: "user",
  id: user.id,
  email: user.email,
  name: user.name,
  notifications_email: user.notifications_email ?? user.email,
  status: user.status,
  theme: user.theme,
  totp_enabled: user.totp_enabled,
  is_owner: user.is_owner,
  referral_code: user.referral_code,
  notification_prefs: {
    referrals: true,
    quota: true,
    security: true,
    ...(user.notification_prefs ?? {}),
  },
  created_at: user.created_at.toISOString(),
})

export const domainListItem = (domain: Domain) => ({
  object: "domain" as const,
  id: domain.id,
  name: domain.name,
  status: domain.status,
  bytes_used: num(domain.bytes_used),
  created_at: domain.created_at.toISOString(),
})

export const domainRecordObject = (record: DomainRecord) => ({
  object: "domain_record" as const,
  id: record.id,
  purpose: record.purpose,
  type: record.type,
  host: record.host,
  value: record.value,
  priority: record.priority,
  ttl: record.ttl,
  required: record.required,
  status: record.status,
  observed: record.observed,
  checked_at: record.checked_at?.toISOString() ?? null,
})

export const domainObject = (
  domain: Domain,
  records: DomainRecord[] = [],
  extra: {
    fallback?: Domain | null
    addressCount?: number
    /**
     * What the caller may do here, so the panel can render one domain page for
     * an owner and for a delegate. Advisory only — every route re-checks. A
     * client that ignored this would get 404s, not access.
     */
    grant?: { owns: boolean; system: boolean }
  } = {},
) => ({
  ...domainListItem(domain),
  can_manage_domain: Boolean(extra.grant?.owns || extra.grant?.system),
  verification_token: domain.verification_token,
  dmarc_policy: domain.dmarc_policy,
  self_service_enabled: domain.self_service_enabled,
  fallback_domain: extra.fallback ? { id: extra.fallback.id, name: extra.fallback.name } : null,
  address_count: extra.addressCount ?? 0,
  verified_at: domain.verified_at?.toISOString() ?? null,
  last_checked_at: domain.last_checked_at?.toISOString() ?? null,
  records: records.map(domainRecordObject),
})

export const addressObject = (
  address: Address,
  extra: { domain?: Domain; destinations?: string[]; filterName?: string | null } = {},
) => ({
  object: "address" as const,
  id: address.id,
  domain_id: address.domain_id,
  local_part: address.local_part,
  email: extra.domain ? `${address.local_part}@${extra.domain.name}` : address.local_part,
  type: address.type,
  name: address.name,
  disabled: address.disabled,
  bytes_used: num(address.bytes_used),
  destinations: extra.destinations ?? [],
  filter_id: address.filter_id,
  recovery_address: address.recovery_address,
  filter_name: extra.filterName ?? null,
  daily_in_limit: address.daily_in_limit,
  daily_out_limit: address.daily_out_limit,
  // Whether this mailbox signs in with the account password rather than one of
  // its own. Never the account id, and never a hash — the panel only needs to
  // know which password to tell someone to use.
  uses_account_password: Boolean(address.user_id),
  last_login_at: address.last_login_at?.toISOString() ?? null,
  created_at: address.created_at.toISOString(),
})

export const filterObject = (filter: Filter) => ({
  object: "filter" as const,
  id: filter.id,
  name: filter.name,
  script: filter.script,
  size: filter.size,
  compile_error: filter.compile_error,
  created_at: filter.created_at.toISOString(),
  updated_at: filter.updated_at.toISOString(),
})

export const transferObject = (transfer: Transfer, extra: { email?: string } = {}) => ({
  object: "transfer" as const,
  id: transfer.id,
  server: transfer.server,
  port: transfer.port,
  secure: transfer.secure,
  username: transfer.username,
  destination: extra.email ?? null,
  address_id: transfer.address_id,
  status: transfer.status,
  message_limit: transfer.message_limit,
  size_limit: transfer.size_limit === null ? null : num(transfer.size_limit),
  newer_than: transfer.newer_than?.toISOString() ?? null,
  folders_total: transfer.folders_total,
  folders_done: transfer.folders_done,
  messages_total: transfer.messages_total,
  messages_done: transfer.messages_done,
  bytes_done: num(transfer.bytes_done),
  last_error: transfer.last_error,
  started_at: transfer.started_at?.toISOString() ?? null,
  finished_at: transfer.finished_at?.toISOString() ?? null,
  created_at: transfer.created_at.toISOString(),
})

export const planObject = (plan: Plan) => ({
  object: "plan" as const,
  id: plan.id,
  key: plan.key,
  name: plan.name,
  storage_bytes: num(plan.storage_bytes),
  daily_in: plan.daily_in,
  daily_out: plan.daily_out,
  monthly_cents: plan.monthly_cents,
  yearly_cents: plan.yearly_cents,
  max_domains: plan.max_domains,
  max_addresses: plan.max_addresses,
  features: plan.features ?? {},
  is_trial: plan.is_trial,
  position: plan.position,
})

export const subscriptionObject = (subscription: Subscription, plan?: Plan | null) => ({
  object: "subscription" as const,
  id: subscription.id,
  status: subscription.status,
  interval: subscription.interval,
  plan: plan ? planObject(plan) : null,
  current_period_start: subscription.current_period_start.toISOString(),
  current_period_end: subscription.current_period_end.toISOString(),
  cancel_at_period_end: subscription.cancel_at_period_end,
  cancelled_at: subscription.cancelled_at?.toISOString() ?? null,
  credit_months: subscription.credit_months,
})

export const transactionObject = (transaction: Transaction) => ({
  object: "transaction" as const,
  id: transaction.id,
  description: transaction.description,
  amount_cents: transaction.amount_cents,
  currency: transaction.currency,
  status: transaction.status,
  invoice_number: transaction.invoice_number,
  transaction_date: transaction.transaction_date.toISOString(),
})

export const paymentMethodObject = (method: PaymentMethod) => ({
  object: "payment_method" as const,
  id: method.id,
  brand: method.brand,
  last4: method.last4,
  exp_month: method.exp_month,
  exp_year: method.exp_year,
  is_default: method.is_default,
  created_at: method.created_at.toISOString(),
})

export const taxIdObject = (taxId: TaxId) => ({
  object: "tax_id" as const,
  id: taxId.id,
  kind: taxId.kind,
  value: taxId.value,
  country: taxId.country,
  business_name: taxId.business_name,
  address_line: taxId.address_line,
})

export const dkimKeyObject = (key: DkimKey) => ({
  object: "dkim_key" as const,
  id: key.id,
  selector: key.selector,
  cname_target: key.cname_target,
  active: key.active,
  created_at: key.created_at.toISOString(),
  rotated_at: key.rotated_at?.toISOString() ?? null,
})

export const messageSummary = (message: Message) => ({
  object: "message" as const,
  id: message.id,
  uid: num(message.uid),
  folder_id: message.folder_id,
  subject: message.subject,
  from: message.from_address,
  to: message.to_addresses ?? [],
  snippet: message.snippet,
  flags: message.flags ?? [],
  size: message.size,
  has_attachments: message.has_attachments,
  internal_date: message.internal_date.toISOString(),
})

export const entitlementObject = (entitlement: Entitlement, usage: Usage) => ({
  object: "entitlement" as const,
  plan: planObject(entitlement.plan),
  subscription: entitlement.subscription
    ? subscriptionObject(entitlement.subscription, entitlement.plan)
    : null,
  features: entitlement.features,
  usage: {
    bytes_used: usage.bytesUsed,
    storage_bytes: usage.storageBytes,
    domains: usage.domains,
    addresses: usage.addresses,
    sent_today: usage.sentToday,
    received_today: usage.receivedToday,
    daily_in: entitlement.dailyIn,
    daily_out: entitlement.dailyOut,
  },
})
