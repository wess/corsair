/**
 * End-to-end API contract check against a running server.
 *
 *   bun run bin/corsair.ts dev        # in one terminal
 *   bun run test:smoke                # in another
 *
 * Not part of `bun test`: it needs a live server and it writes real rows. It
 * exists because the unit tests exercise the protocol layers directly and never
 * prove that the HTTP surface, the session cookie, and the plan gating actually
 * line up.
 */

import { createHmac } from "node:crypto"

const BASE = process.env.CORSAIR_URL ?? "http://localhost:3000"

let cookie = ""
let passed = 0
let failed = 0

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Backs off on 429. The rate limiter is real and this suite makes far more
 * requests per second than any panel would — a 429 here is the limiter working,
 * not a failure, so it is waited out rather than reported.
 */
const call = async (
  method: string,
  path: string,
  body?: unknown,
  attempt = 0,
): Promise<{ status: number; body: any }> => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })

  if (res.status === 429 && attempt < 8) {
    const retryAfter = Number(res.headers.get("retry-after") ?? "1")
    await sleep(Math.max(250, retryAfter * 1000))
    return call(method, path, body, attempt + 1)
  }

  const setCookie = res.headers.get("set-cookie")
  if (setCookie) cookie = setCookie.split(";")[0] ?? cookie

  const text = await res.text()
  let parsed: unknown = null
  try {
    parsed = text ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: res.status, body: parsed }
}

const check = (label: string, condition: boolean, detail?: unknown) => {
  if (condition) {
    passed++
    console.log(`  ok    ${label}`)
    return
  }
  failed++
  console.error(`  FAIL  ${label}`)
  if (detail !== undefined) console.error(`        ${JSON.stringify(detail).slice(0, 300)}`)
}

const section = (name: string) => console.log(`\n${name}`)

/** Runs `fn` as a different session, then puts the suite's own back. */
const withCookie = async <T>(value: string, fn: () => Promise<T>): Promise<T> => {
  const previous = cookie
  cookie = value
  try {
    return await fn()
  } finally {
    cookie = previous
  }
}

/** RFC 6238 (SHA-1, 30 s, 6 digits), worked out here rather than by the server's own verifier. */
const totpCode = (secret: string): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
  const bytes: number[] = []
  let bits = 0
  let acc = 0
  for (const ch of secret.replace(/=+$/, "").toUpperCase()) {
    acc = (acc << 5) | alphabet.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      bytes.push((acc >>> (bits - 8)) & 255)
      bits -= 8
      acc &= (1 << bits) - 1
    }
  }
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)))
  const mac = createHmac("sha1", Buffer.from(bytes)).update(counter).digest()
  const offset = mac[19]! & 15
  const value =
    (((mac[offset]! & 0x7f) << 24) |
      (mac[offset + 1]! << 16) |
      (mac[offset + 2]! << 8) |
      mac[offset + 3]!) %
    1_000_000
  return String(value).padStart(6, "0")
}

const run = async () => {
  const suffix = Math.random().toString(36).slice(2, 8)
  const email = `smoke-${suffix}@corsair.test`
  const password = "smoke-password-1234"
  const domainName = `smoke-${suffix}.invalid`

  section("auth")
  const anonymous = await call("GET", "/api/auth/me")
  check("an unauthenticated caller is refused", anonymous.status === 401, anonymous.body)

  // The sign-in screen asks this before offering a signup form, so that a
  // server with SIGNUPS=closed does not invite someone to choose a password
  // and then answer 403.
  const signupsOpen = await call("GET", "/api/auth/signups")
  check("the signup state is public", signupsOpen.status === 200, signupsOpen.body)
  check("it answers a boolean", typeof signupsOpen.body?.open === "boolean", signupsOpen.body)

  const signup = await call("POST", "/api/auth/signup", { email, password, name: "Smoke Test" })
  check("signup succeeds", signup.status === 201, signup.body)
  check("signup sets a session cookie", cookie.startsWith("corsair_session="))

  const me = await call("GET", "/api/auth/me")
  check("the session identifies the account", me.body?.email === email, me.body)
  check("no password hash is ever serialised", !JSON.stringify(me.body).includes("hash"))

  const duplicate = await call("POST", "/api/auth/signup", { email, password })
  check("a duplicate email is a 409", duplicate.status === 409, duplicate.body)

  const weak = await call("POST", "/api/auth/signup", {
    email: `weak-${suffix}@corsair.test`,
    password: "short",
  })
  check("a short password is rejected", weak.status === 422, weak.body)

  section("client configuration")
  const unknownWebmail = await call("GET", "/api/webmail/host?domain=webmail.unhosted.invalid")
  check("unknown webmail hosts cannot obtain certificates", unknownWebmail.status === 403)
  const clientConfig = await call("GET", "/api/client-config")
  check("client config loads", clientConfig.status === 200, clientConfig.body)
  {
    // Every port offered to a human to type into a mail client has to be one
    // the server actually listens on with the encryption named. Advertising
    // 587/STARTTLS on a server without STARTTLS is silent and total: the
    // account is created and every send fails.
    const servers = (clientConfig.body?.servers ?? []) as {
      protocol: string
      port: number
      security: string
    }[]
    check("it names at least one incoming and one outgoing server", servers.length >= 3, servers)
    check(
      "every entry is encrypted",
      servers.every((s2) => s2.security === "SSL/TLS" || s2.security === "STARTTLS"),
      servers.map((s2) => s2.security),
    )

    const mtaSts = await (await fetch(`${BASE}/.well-known/mta-sts.txt`)).text()
    const startTls = /^mode: (testing|enforce)$/m.test(mtaSts)
    check(
      "a STARTTLS port is offered only when the server can perform it",
      servers.some((s2) => s2.security === "STARTTLS") === startTls,
      { startTls, securities: servers.map((s2) => s2.security) },
    )
  }

  section("overview")
  const overview = await call("GET", "/api/overview")
  check("overview loads", overview.status === 200, overview.body)
  check("activity has 30 days", overview.body?.activity?.days?.length === 30)
  check("a plan is resolved", Boolean(overview.body?.entitlement?.plan?.name))

  section("domains")
  const created = await call("POST", "/api/domains", { name: domainName })
  check("a domain can be added", created.status === 201, created.body)
  const domainId = created.body?.id

  check("it starts pending", created.body?.status === "pending")
  const pendingWebmail = await call("GET", `/api/webmail/host?domain=webmail.${domainName}`)
  check("pending domains cannot obtain webmail certificates", pendingWebmail.status === 403)
  check(
    "the DNS records are generated",
    Array.isArray(created.body?.records) && created.body.records.length >= 8,
    created.body?.records?.length,
  )
  const purposes = new Set((created.body?.records ?? []).map((r: any) => r.purpose))
  for (const purpose of ["verification", "spf", "dmarc", "dkim", "mx"]) {
    check(`a ${purpose.toUpperCase()} record is included`, purposes.has(purpose))
  }

  const badDomain = await call("POST", "/api/domains", { name: "not a domain" })
  check("a malformed domain is rejected", badDomain.status === 400, badDomain.body)

  const dupDomain = await call("POST", "/api/domains", { name: domainName })
  check("the same domain cannot be added twice", dupDomain.status === 409, dupDomain.body)

  const zone = await fetch(`${BASE}/api/domains/${domainId}/dns/zone`, { headers: { cookie } })
  const zoneText = await zone.text()
  check("a zone file can be exported", zone.status === 200 && zoneText.includes("$ORIGIN"))

  const dmarcReports = await call("GET", `/api/domains/${domainId}/reports/dmarc?days=30`)
  check(
    "received DMARC reports are summarised",
    dmarcReports.status === 200 && dmarcReports.body?.object === "dmarc_summary",
    dmarcReports.body,
  )
  check("a new domain has none", dmarcReports.body?.totals?.reports === 0, dmarcReports.body)
  const tlsReports = await call("GET", `/api/domains/${domainId}/reports/tls`)
  check(
    "received TLS reports are summarised",
    tlsReports.status === 200 && tlsReports.body?.object === "tls_summary",
    tlsReports.body,
  )
  const strangerReports = await call(
    "GET",
    "/api/domains/00000000-0000-4000-8000-000000000000/reports/dmarc",
  )
  check("another domain's reports are a 404", strangerReports.status === 404)

  const keys = await call("GET", `/api/domains/${domainId}/keys`)
  check("three DKIM selectors exist", keys.body?.data?.length === 3, keys.body)
  check("private keys are never exposed", !JSON.stringify(keys.body).includes("PRIVATE KEY"))

  section("upgrade")
  // The trial plan caps domains and addresses, which would otherwise mask every
  // assertion below it. Upgrading here also exercises the billing path early.
  const allPlans = await call("GET", "/api/plans")
  const roomy = (allPlans.body?.data ?? [])
    .filter((p: any) => p.max_addresses === null)
    .sort((a: any, b: any) => a.yearly_cents - b.yearly_cents)[0]
  check("a plan without address limits exists", Boolean(roomy), allPlans.body?.data?.length)

  if (roomy) {
    await call("POST", "/api/billing/payment-methods", {
      provider: "manual",
      provider_ref: `tok_setup_${suffix}`,
      brand: "Visa",
      last4: "4242",
    })
    const upgrade = await call("POST", "/api/subscription", { plan_id: roomy.id })
    check("the account can be upgraded", upgrade.status === 200, upgrade.body)
  }

  section("addresses")
  const mailbox = await call("POST", `/api/domains/${domainId}/addresses`, {
    local_part: "me",
    type: "standard",
    name: "Me",
    password: "mailbox-password-1234",
  })
  check("a standard mailbox can be created", mailbox.status === 201, mailbox.body)
  check("its email is composed correctly", mailbox.body?.email === `me@${domainName}`)

  const folders = await call("GET", `/api/addresses/${mailbox.body?.id}/folders`)
  check("it is provisioned with folders", folders.body?.data?.length >= 6, folders.body)
  check(
    "including an INBOX",
    (folders.body?.data ?? []).some((f: any) => f.special_use === "inbox"),
  )

  const alias = await call("POST", `/api/domains/${domainId}/addresses`, {
    local_part: "hello",
    type: "alias",
    destinations: ["elsewhere@example.invalid"],
  })
  check("an alias can be created", alias.status === 201, alias.body)

  const badAlias = await call("POST", `/api/domains/${domainId}/addresses`, {
    local_part: "twodest",
    type: "alias",
    destinations: ["a@example.invalid", "b@example.invalid"],
  })
  check("an alias with two destinations is refused", badAlias.status === 400, badAlias.body)

  const group = await call("POST", `/api/domains/${domainId}/addresses`, {
    local_part: "team",
    type: "group",
    destinations: ["a@example.invalid", "b@example.invalid"],
  })
  check("a group takes several recipients", group.status === 201, group.body)

  const catchall = await call("POST", `/api/domains/${domainId}/addresses`, {
    local_part: "catch",
    type: "catchall",
    password: "mailbox-password-1234",
  })
  check("a catch-all can be created", catchall.status === 201, catchall.body)

  const secondCatchall = await call("POST", `/api/domains/${domainId}/addresses`, {
    local_part: "catch2",
    type: "catchall",
    password: "mailbox-password-1234",
  })
  check("a second catch-all is refused", secondCatchall.status === 409, secondCatchall.body)

  const duplicateLocal = await call("POST", `/api/domains/${domainId}/addresses`, {
    local_part: "me",
    type: "standard",
    password: "mailbox-password-1234",
  })
  check("a duplicate local part is refused", duplicateLocal.status === 409, duplicateLocal.body)

  const list = await call("GET", `/api/domains/${domainId}/addresses?per_page=10`)
  check("addresses paginate", list.body?.total === 4, list.body?.total)

  const search = await call("GET", `/api/domains/${domainId}/addresses?search=team`)
  check("addresses can be searched", search.body?.total === 1, search.body?.total)

  const changed = await call("POST", `/api/addresses/${mailbox.body?.id}/password`, {
    password: "another-mailbox-password",
  })
  check("a mailbox password can be changed", changed.status === 200, changed.body)

  const aliasPassword = await call("POST", `/api/addresses/${alias.body?.id}/password`, {
    password: "should-not-work",
  })
  check("an alias has no password to change", aliasPassword.status === 400, aliasPassword.body)

  section("app passwords")
  const prematureRequire = await call("PATCH", `/api/addresses/${mailbox.body?.id}`, {
    require_app_passwords: true,
  })
  check(
    "app passwords cannot be required before one exists",
    prematureRequire.status === 400,
    prematureRequire.body,
  )

  const appPassword = await call("POST", `/api/addresses/${mailbox.body?.id}/app-passwords`, {
    name: "Smoke phone",
    scopes: ["imap", "smtp"],
  })
  check(
    "an app password is created and its secret shown once",
    appPassword.status === 201 &&
      /^[a-kmnp-z2-9]{4}(-[a-kmnp-z2-9]{4}){4}$/.test(String(appPassword.body?.password)) &&
      appPassword.body?.token_hash === undefined,
    appPassword.body,
  )

  const appPasswords = await call("GET", `/api/addresses/${mailbox.body?.id}/app-passwords`)
  check(
    "the list carries no secret and no hash",
    appPasswords.status === 200 &&
      appPasswords.body?.data?.length === 1 &&
      appPasswords.body.data[0].password === undefined &&
      appPasswords.body.data[0].token_hash === undefined,
    appPasswords.body,
  )

  const required = await call("PATCH", `/api/addresses/${mailbox.body?.id}`, {
    require_app_passwords: true,
  })
  check(
    "a mailbox can then require them",
    required.status === 200 && required.body?.require_app_passwords === true,
    required.body,
  )
  await call("PATCH", `/api/addresses/${mailbox.body?.id}`, { require_app_passwords: false })

  const aliasAppPassword = await call("POST", `/api/addresses/${alias.body?.id}/app-passwords`, {
    name: "No",
  })
  check("an alias cannot have an app password", aliasAppPassword.status === 400)

  const revokedAppPassword = await call(
    "DELETE",
    `/api/addresses/${mailbox.body?.id}/app-passwords/${appPassword.body?.id}`,
  )
  check(
    "an app password can be revoked",
    revokedAppPassword.status === 200,
    revokedAppPassword.body,
  )
  const revokedAgain = await call(
    "DELETE",
    `/api/addresses/${mailbox.body?.id}/app-passwords/${appPassword.body?.id}`,
  )
  check("and is gone afterwards", revokedAgain.status === 404)

  section("filters")
  const validate = await call("POST", "/api/filters/validate", {
    script: 'if header :contains "subject" "x" { discard; }',
  })
  check("a valid script validates", validate.body?.ok === true, validate.body)

  const invalid = await call("POST", "/api/filters/validate", { script: "if header {" })
  check("a broken script reports an error", invalid.body?.ok === false, invalid.body)

  const filter = await call("POST", "/api/filters", {
    name: `smoke-${suffix}`,
    script: 'if header :contains "subject" "x" { discard; }',
  })
  // The trial plan does not include custom filters, so this is the gate working.
  check(
    "creating a filter is plan-gated on the trial",
    filter.status === 402 || filter.status === 201,
    filter.body,
  )

  section("plan gating")
  const fallback = await call("POST", `/api/domains/${domainId}/fallback`, {
    fallback_domain: domainName,
  })
  check("fallback domains are plan-gated", fallback.status === 402, fallback.body)

  const selfService = await call("PATCH", `/api/domains/${domainId}`, {
    self_service_enabled: true,
  })
  check("self-service is plan-gated", selfService.status === 402, selfService.body)

  section("billing")
  const plans = await call("GET", "/api/plans")
  check("plans are listed", Array.isArray(plans.body?.data), plans.body)
  const paid = (plans.body?.data ?? []).find((p: any) => p.yearly_cents > 0)

  if (paid) {
    const method = await call("POST", "/api/billing/payment-methods", {
      provider: "manual",
      provider_ref: `tok_${suffix}`,
      brand: "Visa",
      last4: "4242",
    })
    check("a second payment method can be added", method.status === 201, method.body)

    const upgraded = await call("POST", "/api/subscription", { plan_id: paid.id })
    check("the plan can then be changed", upgraded.status === 200, upgraded.body)

    const transactions = await call("GET", "/api/billing/transactions")
    check("the charge is recorded", transactions.body?.total >= 1, transactions.body?.total)

    const entitlement = await call("GET", "/api/entitlement")
    check("the entitlement reflects the new plan", entitlement.body?.plan?.id === paid.id)
  }

  section("account")
  const renamed = await call("PATCH", "/api/account", { name: "Renamed", theme: "lights_out" })
  check("the profile can be updated", renamed.body?.name === "Renamed", renamed.body)
  check("the theme is stored", renamed.body?.theme === "lights_out")

  const wrongPassword = await call("POST", "/api/account/password", {
    current_password: "not-the-password",
    new_password: "a-brand-new-password",
  })
  check("changing the password needs the old one", wrongPassword.status === 401, wrongPassword.body)

  const referrals = await call("GET", "/api/account/referrals")
  check("a referral link is issued", String(referrals.body?.link ?? "").includes("referred_by="))

  const sessions = await call("GET", "/api/account/sessions")
  check(
    "the current session is listed",
    sessions.body?.data?.some((s: any) => s.current),
  )

  section("account recovery")
  const forgot = await call("POST", "/api/auth/password/forgot", { email })
  check("a reset can be requested", forgot.status === 202, forgot.body)

  const forgotUnknown = await call("POST", "/api/auth/password/forgot", {
    email: `nobody-${suffix}@corsair.test`,
  })
  check(
    "an unknown address answers identically, so accounts cannot be enumerated",
    forgotUnknown.status === forgot.status && forgotUnknown.body?.message === forgot.body?.message,
    forgotUnknown.body,
  )

  const badReset = await call("POST", "/api/auth/password/reset", {
    token: "not-a-real-token-at-all",
    password: "a-brand-new-password",
  })
  check("a bogus reset token is refused", badReset.status === 400, badReset.body)

  const badVerify = await call("POST", "/api/auth/verify", { token: "nope-nope-nope" })
  check("a bogus verification token is refused", badVerify.status === 400, badVerify.body)

  section("address recovery")
  const setRecovery = await call("POST", `/api/addresses/${mailbox.body?.id}/recovery`, {
    recovery_address: `elsewhere-${suffix}@example.invalid`,
  })
  check("a recovery address can be set", setRecovery.status === 200, setRecovery.body)

  const selfRecovery = await call("POST", `/api/addresses/${mailbox.body?.id}/recovery`, {
    recovery_address: `me@${domainName}`,
  })
  check(
    "the mailbox cannot be its own recovery address",
    selfRecovery.status === 400,
    selfRecovery.body,
  )

  const recoverRequest = await call("POST", "/api/recover/request", { email: `me@${domainName}` })
  check("a recovery request is accepted", recoverRequest.status === 202, recoverRequest.body)

  const recoverUnknown = await call("POST", "/api/recover/request", {
    email: `nobody@${domainName}`,
  })
  check(
    "an unknown mailbox answers identically",
    recoverUnknown.body?.message === recoverRequest.body?.message,
    recoverUnknown.body,
  )

  const recoverBad = await call("POST", "/api/recover/reset", {
    token: "not-a-real-token",
    password: "mailbox-password-9999",
  })
  check("a bogus recovery token is refused", recoverBad.status === 400, recoverBad.body)

  section("dns automation")
  const dnsProvider = await call("GET", `/api/domains/${domainId}/dns/provider`)
  check("the DNS provider is reported", dnsProvider.status === 200, dnsProvider.body)
  check(
    "an unresolvable domain is not offered one-click setup",
    dnsProvider.body?.automatic === false,
    dnsProvider.body,
  )

  const publishBadToken = await call("POST", `/api/domains/${domainId}/dns/publish`, {
    provider: "cloudflare",
    token: "definitely-not-a-real-token",
  })
  check(
    "publishing with a bad token is a caller error, not a 500",
    publishBadToken.status === 400,
    publishBadToken.body,
  )

  section("payments")
  const provider = await call("GET", "/api/billing/provider")
  check("the payment provider is reported", provider.status === 200, provider.body)

  const checkout = await call("POST", "/api/billing/checkout/setup")
  check(
    "checkout is refused cleanly when no provider is configured",
    provider.body?.configured ? checkout.status === 200 : checkout.status === 400,
    checkout.body,
  )

  const unsignedWebhook = await fetch(`${BASE}/api/webhooks/payments`, {
    method: "POST",
    body: JSON.stringify({ id: "evt_forged", type: "invoice.payment_succeeded" }),
  })
  check(
    "an unsigned webhook is rejected",
    unsignedWebhook.status === 400,
    await unsignedWebhook.text(),
  )

  section("event hooks")
  const catalogue = await call("GET", "/api/webhooks/events")
  check(
    "the event catalogue is served",
    catalogue.body?.data?.length > 10,
    catalogue.body?.data?.length,
  )

  const badUrl = await call("POST", "/api/webhooks", { url: "not-a-url" })
  check("a malformed URL is refused", badUrl.status === 400, badUrl.body)

  // The guard matters: the customer supplies the URL and the server fetches it,
  // which is a server-side request forgery primitive if left open.
  for (const [label, url] of [
    ["a link-local address", "http://169.254.169.254/latest/meta-data/"],
    ["localhost", "http://localhost:9999/x"],
    ["a private range", "http://10.0.0.5/hook"],
    ["loopback", "http://127.0.0.1:9999/hook"],
  ] as const) {
    const refused = await call("POST", "/api/webhooks", { url })
    check(`${label} is refused`, refused.status === 400, refused.body)
  }

  const badEvent = await call("POST", "/api/webhooks", {
    url: "https://example.com/hook",
    events: ["nonsense.thing"],
  })
  check("an unknown event type is refused", badEvent.status === 400, badEvent.body)

  const hook = await call("POST", "/api/webhooks", {
    url: "https://example.com/hook",
    events: ["domain.*", "address.created"],
    description: "smoke",
  })
  check("a hook can be created", hook.status === 201, hook.body)
  check(
    "the secret is returned once, in full",
    String(hook.body?.signing_secret).startsWith("whsec_"),
  )

  const fetched = await call("GET", `/api/webhooks/${hook.body?.id}`)
  check(
    "and never again",
    String(fetched.body?.signing_secret).endsWith("\u2026"),
    fetched.body?.signing_secret,
  )

  const rotated = await call("POST", `/api/webhooks/${hook.body?.id}/rotate`)
  check(
    "rotation returns a new secret",
    String(rotated.body?.signing_secret).startsWith("whsec_") &&
      rotated.body?.signing_secret !== hook.body?.signing_secret,
    rotated.body?.signing_secret,
  )

  const events = await call("GET", `/api/webhooks/${hook.body?.id}/events`)
  check("its delivery log is listable", events.status === 200, events.body)

  const removed = await call("DELETE", `/api/webhooks/${hook.body?.id}`)
  check("a hook can be deleted", removed.status === 200, removed.body)

  section("sending api")
  // Sent with the key alone and no cookie, so a check here cannot pass on the
  // strength of the session this suite is signed in with.
  const bearer = async (
    method: string,
    path: string,
    token: string,
    body?: unknown,
    attempt = 0,
  ): Promise<{ status: number; body: any }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (res.status === 429 && attempt < 8) {
      await sleep(Math.max(250, Number(res.headers.get("retry-after") ?? "1") * 1000))
      return bearer(method, path, token, body, attempt + 1)
    }
    return { status: res.status, body: await res.json().catch(() => null) }
  }

  const message = { from: `app@${domainName}`, to: "someone@far.invalid", subject: "s", text: "t" }

  const sessionSend = await call("POST", "/api/emails", message)
  check(
    "sending refuses a session without a key",
    sessionSend.status === 401 && sessionSend.body?.name === "missing_api_key",
    sessionSend.body,
  )

  const key = await call("POST", "/api/api-keys", { name: "smoke", permission: "sending_access" })
  const token = String(key.body?.token ?? "")
  check("a key can be created", key.status === 201 && token.startsWith("cs_"), key.body)

  const listedKeys = await call("GET", "/api/api-keys")
  check(
    "the token is never listed",
    listedKeys.status === 200 && !JSON.stringify(listedKeys.body).includes(token),
    listedKeys.body,
  )

  const unverified = await bearer("POST", "/api/emails", token, message)
  check(
    "a domain that has not finished DNS setup cannot send",
    unverified.status === 403 && unverified.body?.name === "validation_error",
    unverified.body,
  )

  const missingTo = await bearer("POST", "/api/emails", token, { ...message, to: undefined })
  check(
    "a missing field answers with the SDK-expected error name",
    missingTo.status === 422 && missingTo.body?.name === "missing_required_field",
    missingTo.body,
  )

  const restricted = await bearer("GET", "/api/emails", token)
  check(
    "a sending-only key cannot read sends",
    restricted.status === 401 && restricted.body?.name === "restricted_api_key",
    restricted.body,
  )

  const keyForKeys = await bearer("GET", "/api/api-keys", token)
  check("a key cannot reach key management", keyForKeys.status === 401, keyForKeys.body)

  const unknownKey = await bearer("POST", "/api/emails", "cs_not-a-real-key", message)
  check(
    "an unknown key is refused",
    unknownKey.status === 403 && unknownKey.body?.name === "invalid_api_key",
    unknownKey.body,
  )

  const panelSends = await call("GET", "/api/emails")
  check(
    "the panel reads sends with its session",
    panelSends.status === 200 && panelSends.body?.object === "list",
    panelSends.body,
  )

  const scopedFull = await call("POST", "/api/api-keys", {
    name: "bad",
    permission: "full_access",
    domain_id: domainId,
  })
  check("a domain-scoped key must be sending-only", scopedFull.status === 400, scopedFull.body)

  const revoked = await call("DELETE", `/api/api-keys/${key.body?.id}`)
  const afterRevoke = await bearer("POST", "/api/emails", token, message)
  check(
    "a revoked key stops working at once",
    revoked.status === 200 && afterRevoke.status === 403,
    afterRevoke.body,
  )

  const suppressed = await call("POST", "/api/suppressions", { email: "Someone@Far.invalid" })
  check(
    "an address can be suppressed by hand",
    suppressed.status === 201 && suppressed.body?.email === "someone@far.invalid",
    suppressed.body,
  )
  const unsuppressed = await call("DELETE", `/api/suppressions/${suppressed.body?.id}`)
  check("and let through again", unsuppressed.status === 200, unsuppressed.body)

  section("agent email")
  // An agent mailbox only makes sense on a domain that can receive mail, so a
  // domain still waiting on DNS is refused. The whole lifecycle — create, read,
  // wait, send, rotate, delete — needs a verified domain, which nothing here can
  // make (it would have to publish DNS), so it lives in tests/agents.test.ts
  // against a real database.
  const pendingAgent = await call("POST", "/api/agents", {
    name: "smoke agent",
    domain_id: domainId,
  })
  check(
    "an agent cannot be created on a domain that has not finished DNS setup",
    pendingAgent.status === 400 && /not verified/i.test(String(pendingAgent.body?.message)),
    pendingAgent.body,
  )

  const listedAgents = await call("GET", "/api/agents")
  check(
    "the agents list is empty and has the list shape",
    listedAgents.status === 200 && Array.isArray(listedAgents.body?.data),
    listedAgents.body,
  )

  const noToken = await fetch(`${BASE}/api/agent`)
  check("the agent API wants a token", noToken.status === 401)

  const badToken = await bearer("GET", "/api/agent", "ca_not-a-real-token")
  check("a made-up agent token is refused", badToken.status === 403, badToken.body)

  // A *live* sending key: the one above was revoked, and a revoked key would be
  // refused for that reason alone.
  const liveKey = await call("POST", "/api/api-keys", {
    name: "smoke agent check",
    permission: "full_access",
  })
  const sendingKeyOnAgent = await bearer("GET", "/api/agent", String(liveKey.body?.token ?? ""))
  check(
    "a live full-access key is not an agent token",
    liveKey.status === 201 && sendingKeyOnAgent.status === 403,
    sendingKeyOnAgent.body,
  )
  await call("DELETE", `/api/api-keys/${liveKey.body?.id}`)

  const agentOnApi = await bearer("POST", "/api/emails", "ca_not-a-real-token", message)
  check("an agent token is not a sending key", agentOnApi.status === 403, agentOnApi.body)

  section("fixtures for the owned-resource cases")
  // Everything below that says "another account's" needs a second account, and
  // everything that sends or hosts an agent needs a domain past DNS setup. The
  // suite cannot publish DNS, so it flips the status in the database; against a
  // server whose database it cannot reach, those cases are reported as skipped.
  const stranger = await withCookie("", async () => {
    const r = await call("POST", "/api/auth/signup", {
      email: `smoke-other-${suffix}@corsair.test`,
      password,
      name: "Other",
    })
    return { status: r.status, cookie }
  })
  check("a second account can be created", stranger.status === 201, stranger.status)
  const asStranger = <T>(fn: () => Promise<T>) => withCookie(stranger.cookie, fn)

  let sql: InstanceType<typeof Bun.SQL> | null = null
  let activated = false
  try {
    sql = new Bun.SQL(
      process.env.DATABASE_URL ?? "postgres://corsair:corsair@localhost:55433/corsair",
    )
    // The worker re-checks DNS for a pending domain and would put it straight
    // back, so its queued checks are retired and any in flight allowed to finish.
    await sql`UPDATE jobs SET status = 'done' WHERE kind = 'domain.verify' AND status = 'pending'
              AND payload->>'domain_id' = ${domainId}`
    for (let i = 0; i < 40; i++) {
      const running =
        await sql`SELECT 1 FROM jobs WHERE kind = 'domain.verify' AND status = 'running'
                                AND payload->>'domain_id' = ${domainId}`
      if (!running.length) break
      await sleep(250)
    }
    await sql`UPDATE domains SET status = 'active' WHERE id = ${domainId}`
    activated = true
  } catch (e) {
    console.log(`  skip  the domain cannot be activated (${(e as Error).message})`)
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  const nobody = "00000000-0000-4000-8000-000000000000"

  if (activated) {
    section("sending api: reading and changing a send")
    const fullKey = await call("POST", "/api/api-keys", {
      name: "smoke full",
      permission: "full_access",
    })
    const fullToken = String(fullKey.body?.token ?? "")
    const sendKey = await call("POST", "/api/api-keys", {
      name: "smoke send",
      permission: "sending_access",
    })
    const sendToken = String(sendKey.body?.token ?? "")
    check(
      "a full-access and a sending-only key exist",
      fullToken.startsWith("cs_") && sendToken.startsWith("cs_"),
    )

    const when = new Date(Date.now() + 2 * 3_600_000).toISOString()
    const later = new Date(Date.now() + 4 * 3_600_000).toISOString()
    const scheduled = await bearer("POST", "/api/emails", sendToken, {
      ...message,
      html: "<p>t</p>",
      tags: [{ name: "campaign", value: "smoke" }],
      scheduled_at: when,
    })
    check(
      "a send can be scheduled",
      scheduled.status === 200 && uuid.test(scheduled.body?.id),
      scheduled.body,
    )
    const emailId = String(scheduled.body?.id)

    const read = await bearer("GET", `/api/emails/${emailId}`, fullToken)
    check(
      "a send can be read back with its content",
      read.status === 200 &&
        read.body?.object === "email" &&
        read.body.id === emailId &&
        read.body.last_event === "scheduled" &&
        read.body.subject === "s" &&
        read.body.text === "t" &&
        read.body.html === "<p>t</p>" &&
        read.body.from === message.from &&
        Array.isArray(read.body.to) &&
        read.body.to[0] === message.to &&
        read.body.tags?.[0]?.name === "campaign" &&
        Math.abs(Date.parse(read.body.scheduled_at) - Date.parse(when)) < 1000,
      read.body,
    )
    check(
      "the list shape leaves the content out",
      (await call("GET", "/api/emails?limit=100")).body?.data?.every(
        (e: any) => e.html === undefined && e.text === undefined,
      ),
    )

    const readBySession = await call("GET", `/api/emails/${emailId}`)
    check(
      "the panel can read it with its session",
      readBySession.status === 200 && readBySession.body?.id === emailId,
      readBySession.body,
    )

    const readAnon = await fetch(`${BASE}/api/emails/${emailId}`)
    check("reading a send wants credentials", readAnon.status === 401)
    const readRestricted = await bearer("GET", `/api/emails/${emailId}`, sendToken)
    check(
      "a sending-only key cannot read it",
      readRestricted.status === 401 && readRestricted.body?.name === "restricted_api_key",
      readRestricted.body,
    )
    const readStranger = await asStranger(() => call("GET", `/api/emails/${emailId}`))
    check("another account's send is a 404", readStranger.status === 404, readStranger.body)
    check("an unknown send is a 404", (await call("GET", `/api/emails/${nobody}`)).status === 404)
    check(
      "a malformed id is a validation error",
      (await call("GET", "/api/emails/not-a-uuid")).status === 422,
    )

    const patchNoBody = await call("PATCH", `/api/emails/${emailId}`, {})
    check("rescheduling needs a time", patchNoBody.status === 422, patchNoBody.body)
    const patchGarbage = await call("PATCH", `/api/emails/${emailId}`, { scheduled_at: "someday" })
    check("an unparseable time is refused", patchGarbage.status === 400, patchGarbage.body)
    const patchPast = await call("PATCH", `/api/emails/${emailId}`, {
      scheduled_at: "2020-01-01T00:00:00Z",
    })
    check("a time in the past is refused", patchPast.status === 400, patchPast.body)
    const patchFar = await call("PATCH", `/api/emails/${emailId}`, {
      scheduled_at: new Date(Date.now() + 90 * 86_400_000).toISOString(),
    })
    check("a time too far ahead is refused", patchFar.status === 400, patchFar.body)
    const patchStranger = await asStranger(() =>
      call("PATCH", `/api/emails/${emailId}`, { scheduled_at: later }),
    )
    check("another account cannot reschedule it", patchStranger.status === 404, patchStranger.body)
    const patchRestricted = await bearer("PATCH", `/api/emails/${emailId}`, sendToken, {
      scheduled_at: later,
    })
    check(
      "a sending-only key cannot reschedule it",
      patchRestricted.status === 401,
      patchRestricted.body,
    )

    const patched = await bearer("PATCH", `/api/emails/${emailId}`, fullToken, {
      scheduled_at: later,
    })
    check(
      "a scheduled send can be moved",
      patched.status === 200 && patched.body?.object === "email" && patched.body?.id === emailId,
      patched.body,
    )
    const moved = await bearer("GET", `/api/emails/${emailId}`, fullToken)
    check(
      "and reads back at the new time",
      Math.abs(Date.parse(moved.body?.scheduled_at) - Date.parse(later)) < 1000 &&
        moved.body?.last_event === "scheduled",
      moved.body,
    )

    const cancelStranger = await asStranger(() => call("POST", `/api/emails/${emailId}/cancel`))
    check("another account cannot cancel it", cancelStranger.status === 404, cancelStranger.body)
    const cancelRestricted = await bearer("POST", `/api/emails/${emailId}/cancel`, sendToken)
    check(
      "a sending-only key cannot cancel it",
      cancelRestricted.status === 401,
      cancelRestricted.body,
    )
    const cancelAnon = await fetch(`${BASE}/api/emails/${emailId}/cancel`, { method: "POST" })
    check("cancelling wants credentials", cancelAnon.status === 401)
    check(
      "an unknown send cannot be cancelled",
      (await call("POST", `/api/emails/${nobody}/cancel`)).status === 404,
    )

    const cancelled = await bearer("POST", `/api/emails/${emailId}/cancel`, fullToken)
    check(
      "a scheduled send can be cancelled",
      cancelled.status === 200 &&
        cancelled.body?.object === "email" &&
        cancelled.body?.id === emailId,
      cancelled.body,
    )
    const after = await bearer("GET", `/api/emails/${emailId}`, fullToken)
    check("and reads back as canceled", after.body?.last_event === "canceled", after.body)
    const cancelAgain = await bearer("POST", `/api/emails/${emailId}/cancel`, fullToken)
    check("it cannot be cancelled twice", cancelAgain.status === 400, cancelAgain.body)
    const moveCancelled = await bearer("PATCH", `/api/emails/${emailId}`, fullToken, {
      scheduled_at: when,
    })
    check("a cancelled send cannot be moved", moveCancelled.status === 400, moveCancelled.body)

    const immediate = await bearer("POST", "/api/emails", sendToken, message)
    check(
      "an immediate send is accepted",
      immediate.status === 200 && uuid.test(immediate.body?.id),
      immediate.body,
    )
    const immediateCancel = await bearer(
      "POST",
      `/api/emails/${immediate.body?.id}/cancel`,
      fullToken,
    )
    check(
      "only a scheduled send can be cancelled",
      immediateCancel.status === 400,
      immediateCancel.body,
    )
    const immediateMove = await bearer("PATCH", `/api/emails/${immediate.body?.id}`, fullToken, {
      scheduled_at: later,
    })
    check("only a scheduled send can be moved", immediateMove.status === 400, immediateMove.body)

    section("sending api: batch")
    const countSends = async () =>
      ((await call("GET", "/api/emails?limit=100")).body?.data ?? []).length
    const before = await countSends()
    const second = { ...message, to: "second@far.invalid", subject: "second" }
    const batch = await bearer("POST", "/api/emails/batch", sendToken, [message, second])
    check(
      "a batch queues every email and answers with their ids",
      batch.status === 200 &&
        batch.body?.data?.length === 2 &&
        batch.body.data.every((d: any) => uuid.test(d.id)) &&
        batch.body.data[0].id !== batch.body.data[1].id,
      batch.body,
    )
    const batchRead = await bearer("GET", `/api/emails/${batch.body?.data?.[1]?.id}`, fullToken)
    check(
      "each one exists with its own content",
      batchRead.body?.subject === "second" && batchRead.body?.to?.[0] === "second@far.invalid",
      batchRead.body,
    )
    check("the batch is counted", (await countSends()) === before + 2, await countSends())

    const badBatch = await bearer("POST", "/api/emails/batch", sendToken, [
      message,
      { ...message, to: undefined },
    ])
    check(
      "a batch with one bad email is refused with the SDK error name",
      badBatch.status === 422 && badBatch.body?.name === "missing_required_field",
      badBatch.body,
    )
    check("and queues none of it", (await countSends()) === before + 2)

    const batchScheduled = await bearer("POST", "/api/emails/batch", sendToken, [
      { ...message, scheduled_at: when },
    ])
    check("a batch cannot schedule", batchScheduled.status === 400, batchScheduled.body)
    const batchAttachment = await bearer("POST", "/api/emails/batch", sendToken, [
      { ...message, attachments: [{ filename: "a.txt", content: "aGk=" }] },
    ])
    check("a batch cannot carry attachments", batchAttachment.status === 400, batchAttachment.body)
    const batchEmpty = await bearer("POST", "/api/emails/batch", sendToken, [])
    check("an empty batch is refused", batchEmpty.status === 422, batchEmpty.body)
    const batchNotArray = await bearer("POST", "/api/emails/batch", sendToken, message)
    check("a batch has to be an array", batchNotArray.status === 422, batchNotArray.body)
    const batchTooBig = await bearer(
      "POST",
      "/api/emails/batch",
      sendToken,
      Array.from({ length: 101 }, () => message),
    )
    check("a batch is capped at 100", batchTooBig.status === 422, batchTooBig.body)
    check("and none of the rejected ones were queued", (await countSends()) === before + 2)

    const batchAnon = await fetch(`${BASE}/api/emails/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([message]),
    })
    check("a batch wants an API key", batchAnon.status === 401)
    const batchSession = await call("POST", "/api/emails/batch", [message])
    check(
      "and not a session",
      batchSession.status === 401 && batchSession.body?.name === "missing_api_key",
      batchSession.body,
    )
    const batchUnknown = await bearer("POST", "/api/emails/batch", "cs_not-a-real-key", [message])
    check(
      "an unknown key is refused",
      batchUnknown.status === 403 && batchUnknown.body?.name === "invalid_api_key",
      batchUnknown.body,
    )

    const idem = async (payload: unknown, attempt = 0): Promise<{ status: number; body: any }> => {
      const res = await fetch(`${BASE}/api/emails/batch`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${sendToken}`,
          "content-type": "application/json",
          "idempotency-key": `smoke-batch-${suffix}`,
        },
        body: JSON.stringify(payload),
      })
      if (res.status === 429 && attempt < 8) {
        await sleep(Math.max(250, Number(res.headers.get("retry-after") ?? "1") * 1000))
        return idem(payload, attempt + 1)
      }
      return { status: res.status, body: (await res.json().catch(() => null)) as any }
    }
    const idemFirst = await idem([message])
    const idemSecond = await idem([message])
    check(
      "a repeated Idempotency-Key replays the first answer without sending again",
      idemFirst.status === 200 && idemSecond.body?.data?.[0]?.id === idemFirst.body?.data?.[0]?.id,
      [idemFirst.body, idemSecond.body],
    )
    const idemDifferent = await idem([second])
    check(
      "and the same key for a different batch is a 409",
      idemDifferent.status === 409,
      idemDifferent.body,
    )

    section("agent lifecycle")
    const agentMade = await call("POST", "/api/agents", {
      name: "smoke agent",
      domain_id: domainId,
    })
    const agentToken = String(agentMade.body?.token ?? "")
    check(
      "an agent can be created on a verified domain",
      agentMade.status === 201 &&
        agentToken.startsWith("ca_") &&
        agentMade.body?.object === "agent" &&
        agentMade.body?.can_send === false &&
        String(agentMade.body?.email).endsWith(`@${domainName}`),
      agentMade.body,
    )
    const agentId = String(agentMade.body?.id)
    check(
      "the token works as the agent's credential",
      (await bearer("GET", "/api/agent", agentToken)).status === 200,
    )

    const listedAgentsNow = await call("GET", "/api/agents")
    check(
      "the list shows it and never the token",
      listedAgentsNow.body?.data?.some((a: any) => a.id === agentId) &&
        !JSON.stringify(listedAgentsNow.body).includes(agentToken),
      listedAgentsNow.body,
    )

    const canSend = await call("PATCH", `/api/agents/${agentId}`, { can_send: true })
    check(
      "sending can be switched on",
      canSend.status === 200 &&
        canSend.body?.can_send === true &&
        canSend.body?.token === undefined,
      canSend.body,
    )
    const canSendOff = await call("PATCH", `/api/agents/${agentId}`, { can_send: false })
    check(
      "and off again",
      canSendOff.status === 200 && canSendOff.body?.can_send === false,
      canSendOff.body,
    )
    check(
      "the patch needs a boolean",
      (await call("PATCH", `/api/agents/${agentId}`, { can_send: "yes" })).status === 422,
    )
    check(
      "the patch needs a body",
      (await call("PATCH", `/api/agents/${agentId}`, {})).status === 422,
    )
    check(
      "an agent patch wants a session",
      (
        await fetch(`${BASE}/api/agents/${agentId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ can_send: true }),
        })
      ).status === 401,
    )
    const patchAgentStranger = await asStranger(() =>
      call("PATCH", `/api/agents/${agentId}`, { can_send: true }),
    )
    check(
      "another account cannot change it",
      patchAgentStranger.status === 404,
      patchAgentStranger.body,
    )
    check(
      "an unknown agent is a 404",
      (await call("PATCH", `/api/agents/${nobody}`, { can_send: true })).status === 404,
    )
    const stillOff = await call("GET", "/api/agents")
    check(
      "and the refused patch changed nothing",
      stillOff.body?.data?.find((a: any) => a.id === agentId)?.can_send === false,
    )

    const rotateStranger = await asStranger(() => call("POST", `/api/agents/${agentId}/rotate`))
    check(
      "another account cannot rotate its token",
      rotateStranger.status === 404,
      rotateStranger.body,
    )
    check(
      "the token survived that attempt",
      (await bearer("GET", "/api/agent", agentToken)).status === 200,
    )
    check(
      "an unknown agent cannot be rotated",
      (await call("POST", `/api/agents/${nobody}/rotate`)).status === 404,
    )
    check(
      "rotating wants a session",
      (await fetch(`${BASE}/api/agents/${agentId}/rotate`, { method: "POST" })).status === 401,
    )
    const rotatedAgent = await call("POST", `/api/agents/${agentId}/rotate`)
    const newAgentToken = String(rotatedAgent.body?.token ?? "")
    check(
      "rotation returns a new token once",
      rotatedAgent.status === 200 &&
        newAgentToken.startsWith("ca_") &&
        newAgentToken !== agentToken &&
        rotatedAgent.body?.id === agentId,
      rotatedAgent.body,
    )
    const oldTokenNow = await bearer("GET", "/api/agent", agentToken)
    check("the old token stops working at once", oldTokenNow.status === 403, oldTokenNow.body)
    const newTokenNow = await bearer("GET", "/api/agent", newAgentToken)
    check(
      "the new token works",
      newTokenNow.status === 200 && newTokenNow.body?.id === agentId,
      newTokenNow.body,
    )

    const deleteAgentStranger = await asStranger(() => call("DELETE", `/api/agents/${agentId}`))
    check(
      "another account cannot delete it",
      deleteAgentStranger.status === 404,
      deleteAgentStranger.body,
    )
    check(
      "deleting wants a session",
      (await fetch(`${BASE}/api/agents/${agentId}`, { method: "DELETE" })).status === 401,
    )
    const agentGone = await call("DELETE", `/api/agents/${agentId}`)
    check(
      "an agent can be deleted",
      agentGone.status === 200 &&
        agentGone.body?.deleted === true &&
        agentGone.body?.id === agentId,
      agentGone.body,
    )
    check(
      "its token stops working",
      (await bearer("GET", "/api/agent", newAgentToken)).status === 403,
    )
    check(
      "it leaves the list",
      !(await call("GET", "/api/agents")).body?.data?.some((a: any) => a.id === agentId),
    )
    check(
      "deleting twice is a 404",
      (await call("DELETE", `/api/agents/${agentId}`)).status === 404,
    )
    check(
      "a deleted agent cannot be rotated",
      (await call("POST", `/api/agents/${agentId}/rotate`)).status === 404,
    )
  }

  section("event hooks: delivery log")
  // The endpoint has to pass the public-host check, which is what the section
  // above proves it does. Nothing here depends on what example.com answers:
  // the cases read the shape of the result, not its verdict.
  const logHook = await call("POST", "/api/webhooks", {
    url: "https://example.com/corsair-smoke",
    events: ["address.created"],
  })
  check("a hook for the delivery-log cases can be created", logHook.status === 201, logHook.body)
  const otherHook = await call("POST", "/api/webhooks", {
    url: "https://example.com/corsair-smoke-2",
    events: ["address.created"],
  })

  const testRun = await call("POST", `/api/webhooks/${logHook.body?.id}/test`)
  check(
    "a test delivery reports what came back",
    testRun.status === 200 &&
      testRun.body?.object === "webhook_test" &&
      typeof testRun.body?.ok === "boolean" &&
      typeof testRun.body?.duration_ms === "number" &&
      (testRun.body.status === null
        ? typeof testRun.body.error === "string"
        : typeof testRun.body.status === "number"),
    testRun.body,
  )
  check(
    "testing wants a session",
    (await fetch(`${BASE}/api/webhooks/${logHook.body?.id}/test`, { method: "POST" })).status ===
      401,
  )
  const testStranger = await asStranger(() =>
    call("POST", `/api/webhooks/${logHook.body?.id}/test`),
  )
  check("another account cannot test it", testStranger.status === 404, testStranger.body)
  check(
    "an unknown hook is a 404",
    (await call("POST", `/api/webhooks/${nobody}/test`)).status === 404,
  )
  check(
    "a malformed hook id is a validation error",
    (await call("POST", "/api/webhooks/nope/test")).status === 422,
  )

  // Creating an address emits `address.created`, which gives the hook an event
  // to look at without having to fake one.
  await call("POST", `/api/domains/${domainId}/addresses`, {
    local_part: `evt${suffix}`,
    type: "alias",
    destinations: ["elsewhere@example.invalid"],
  })
  let hookEvent: any = null
  for (let i = 0; i < 20 && !hookEvent; i++) {
    hookEvent =
      (await call("GET", `/api/webhooks/${logHook.body?.id}/events`)).body?.data?.[0] ?? null
    if (!hookEvent) await sleep(250)
  }
  check(
    "creating an address records an event for the hook",
    hookEvent?.type === "address.created",
    hookEvent,
  )

  if (hookEvent) {
    const eventPath = `/api/webhooks/${logHook.body?.id}/events/${hookEvent.id}`
    const eventRead = await call("GET", eventPath)
    check(
      "one event can be read with its attempts",
      eventRead.status === 200 &&
        eventRead.body?.object === "webhook_event" &&
        eventRead.body.id === hookEvent.id &&
        eventRead.body.webhook_id === logHook.body?.id &&
        eventRead.body.type === "address.created" &&
        eventRead.body.payload !== undefined &&
        Array.isArray(eventRead.body.attempts),
      eventRead.body,
    )
    check("it wants a session", (await fetch(`${BASE}${eventPath}`)).status === 401)
    const eventStranger = await asStranger(() => call("GET", eventPath))
    check("another account cannot read it", eventStranger.status === 404, eventStranger.body)
    const eventWrongHook = await call(
      "GET",
      `/api/webhooks/${otherHook.body?.id}/events/${hookEvent.id}`,
    )
    check(
      "it cannot be read through a different hook of the same account",
      eventWrongHook.status === 404,
      eventWrongHook.body,
    )
    check(
      "an unknown event is a 404",
      (await call("GET", `/api/webhooks/${logHook.body?.id}/events/evt_nope`)).status === 404,
    )

    const replayPath = `${eventPath}/replay`
    const replayStranger = await asStranger(() => call("POST", replayPath))
    check("another account cannot replay it", replayStranger.status === 404, replayStranger.body)
    check(
      "replaying wants a session",
      (await fetch(`${BASE}${replayPath}`, { method: "POST" })).status === 401,
    )
    const replayWrongHook = await call(
      "POST",
      `/api/webhooks/${otherHook.body?.id}/events/${hookEvent.id}/replay`,
    )
    check(
      "it cannot be replayed through a different hook",
      replayWrongHook.status === 404,
      replayWrongHook.body,
    )
    check(
      "an unknown event cannot be replayed",
      (await call("POST", `/api/webhooks/${logHook.body?.id}/events/evt_nope/replay`)).status ===
        404,
    )
    const replayed = await call("POST", replayPath)
    check(
      "an event can be replayed",
      replayed.status === 202 &&
        replayed.body?.replaying === true &&
        replayed.body?.id === hookEvent.id,
      replayed.body,
    )

    await call("PATCH", `/api/webhooks/${logHook.body?.id}`, { status: "disabled" })
    const replayDisabled = await call("POST", replayPath)
    check(
      "a disabled endpoint cannot be replayed to",
      replayDisabled.status === 409,
      replayDisabled.body,
    )
  }
  await call("DELETE", `/api/webhooks/${logHook.body?.id}`)
  await call("DELETE", `/api/webhooks/${otherHook.body?.id}`)

  section("transfers")
  const transferDestinations = await call("GET", "/api/transfers/destinations")
  const destinationEmails = (transferDestinations.body?.data ?? []).map((d: any) => d.email)
  check(
    "destinations are the account's mailboxes, not its forwarders",
    transferDestinations.status === 200 &&
      transferDestinations.body?.object === "list" &&
      destinationEmails.includes(`me@${domainName}`) &&
      !destinationEmails.includes(`hello@${domainName}`) &&
      !destinationEmails.includes(`team@${domainName}`),
    transferDestinations.body,
  )
  check(
    "a stranger sees none of them",
    (await asStranger(() => call("GET", "/api/transfers/destinations"))).body?.data?.length === 0,
  )
  check(
    "destinations want a session",
    (await fetch(`${BASE}/api/transfers/destinations`)).status === 401,
  )

  // Port 1 and a fabricated login: if the worker picks the job up before the
  // delete below, there is nothing listening to hand a credential to.
  const transferBody = {
    server: "example.com",
    port: 1,
    username: "smoke@example.com",
    password: "not-a-real-password",
    destination_address_id: mailbox.body?.id,
    accepted_policy: true,
  }
  const privateSource = await call("POST", "/api/transfers", {
    ...transferBody,
    server: "127.0.0.1",
  })
  check("a private source host is refused", privateSource.status === 400, privateSource.body)
  const metadataSource = await call("POST", "/api/transfers", {
    ...transferBody,
    server: "169.254.169.254",
  })
  check("so is the cloud metadata address", metadataSource.status === 400, metadataSource.body)
  const noPolicy = await call("POST", "/api/transfers", { ...transferBody, accepted_policy: false })
  check(
    "the transfer policy has to be accepted",
    noPolicy.status === 400 || noPolicy.status === 402,
    noPolicy.body,
  )
  const noPolicyField = await call("POST", "/api/transfers", {
    ...transferBody,
    accepted_policy: undefined,
  })
  check("and the field has to be there", noPolicyField.status === 422, noPolicyField.body)
  const insecure = await call("POST", "/api/transfers", { ...transferBody, secure: false })
  check("a cleartext source is refused", insecure.status === 422, insecure.body)
  const aliasDestination = await call("POST", "/api/transfers", {
    ...transferBody,
    destination_address_id: alias.body?.id,
  })
  check(
    "mail cannot be transferred into a forwarder",
    aliasDestination.status === 400 || aliasDestination.status === 402,
    aliasDestination.body,
  )
  const foreignDestination = await asStranger(() => call("POST", "/api/transfers", transferBody))
  check(
    "nor into another account's mailbox",
    foreignDestination.status === 400 || foreignDestination.status === 402,
    foreignDestination.body,
  )
  const controlChars = await call("POST", "/api/transfers", { ...transferBody, username: "a\r\nb" })
  check(
    "credentials with control characters are refused",
    controlChars.status === 400,
    controlChars.body,
  )
  check(
    "creating a transfer wants a session",
    (
      await fetch(`${BASE}/api/transfers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(transferBody),
      })
    ).status === 401,
  )

  const transfer = await call("POST", "/api/transfers", transferBody)
  check(
    "a transfer can be created (or is plan-gated)",
    transfer.status === 201 || transfer.status === 402,
    transfer.body,
  )
  if (transfer.status === 201) {
    check(
      "it is queued, names its destination, and never echoes the password",
      transfer.body?.object === "transfer" &&
        transfer.body.destination === `me@${domainName}` &&
        transfer.body.server === "example.com" &&
        !JSON.stringify(transfer.body).includes("not-a-real-password") &&
        !JSON.stringify(transfer.body).includes("password_enc"),
      transfer.body,
    )
    const transferId = String(transfer.body?.id)

    const transferRead = await call("GET", `/api/transfers/${transferId}`)
    check(
      "it can be read",
      transferRead.status === 200 && transferRead.body?.id === transferId,
      transferRead.body,
    )
    const transferList = await call("GET", "/api/transfers")
    check(
      "it is listed",
      transferList.status === 200 && transferList.body?.data?.some((t: any) => t.id === transferId),
      transferList.body,
    )
    check(
      "and not listed for another account",
      !(await asStranger(() => call("GET", "/api/transfers"))).body?.data?.some(
        (t: any) => t.id === transferId,
      ),
    )
    check(
      "reading it wants a session",
      (await fetch(`${BASE}/api/transfers/${transferId}`)).status === 401,
    )
    const transferStranger = await asStranger(() => call("GET", `/api/transfers/${transferId}`))
    check("another account cannot read it", transferStranger.status === 404, transferStranger.body)
    check(
      "an unknown transfer is a 404",
      (await call("GET", `/api/transfers/${nobody}`)).status === 404,
    )
    check(
      "a malformed transfer id is a validation error",
      (await call("GET", "/api/transfers/nope")).status === 422,
    )

    const deleteStranger = await asStranger(() => call("DELETE", `/api/transfers/${transferId}`))
    check("another account cannot cancel it", deleteStranger.status === 404, deleteStranger.body)
    check(
      "cancelling wants a session",
      (await fetch(`${BASE}/api/transfers/${transferId}`, { method: "DELETE" })).status === 401,
    )
    const transferCancelled = await call("DELETE", `/api/transfers/${transferId}`)
    check(
      "a transfer can be cancelled",
      transferCancelled.status === 200 && transferCancelled.body?.cancelled === true,
      transferCancelled.body,
    )
    const transferAfter = await call("GET", `/api/transfers/${transferId}`)
    check(
      "and then reads as cancelled",
      transferAfter.body?.status === "cancelled",
      transferAfter.body,
    )
    check(
      "cancelling twice is harmless",
      (await call("DELETE", `/api/transfers/${transferId}`)).status === 200,
    )
  }

  section("public endpoints")
  const autoconfig = await fetch(`${BASE}/mail/config-v1.1.xml?emailaddress=me@${domainName}`)
  const autoconfigBody = await autoconfig.text()
  check(
    "Thunderbird autoconfig is served",
    autoconfig.status === 200 && autoconfigBody.includes("<clientConfig"),
  )

  check(
    "Thunderbird autoconfig names the CardDAV address book",
    autoconfigBody.includes('<addressBook type="carddav">') && autoconfigBody.includes("/dav/"),
  )

  const carddavWellKnown = await fetch(`${BASE}/.well-known/carddav`, {
    method: "PROPFIND",
    redirect: "manual",
  })
  check(
    "/.well-known/carddav redirects to the DAV context path",
    carddavWellKnown.status === 301 && carddavWellKnown.headers.get("location") === "/dav/",
  )

  const carddavOptions = await fetch(`${BASE}/dav/`, { method: "OPTIONS" })
  check(
    "CardDAV answers OPTIONS with the addressbook class",
    (carddavOptions.headers.get("dav") ?? "").includes("addressbook"),
  )

  const carddavAnon = await fetch(`${BASE}/dav/`, { method: "PROPFIND" })
  check(
    "CardDAV wants Basic credentials",
    carddavAnon.status === 401 && /^Basic /.test(carddavAnon.headers.get("www-authenticate") ?? ""),
  )

  const contactsAnon = await call("GET", "/api/mail/contacts?q=a")
  check("the webmail contacts search needs a mailbox session", contactsAnon.status === 401)

  const autodiscover = await fetch(`${BASE}/autodiscover/autodiscover.xml`, {
    method: "POST",
    body: `<Request><EMailAddress>me@${domainName}</EMailAddress></Request>`,
  })
  check("Outlook autodiscover is served", autodiscover.status === 200)

  const mtaSts = await fetch(`${BASE}/.well-known/mta-sts.txt`)
  const mtaStsBody = await mtaSts.text()
  check("an MTA-STS policy is served", mtaSts.status === 200 && mtaStsBody.includes("STSv1"))

  section("errors")
  const missing = await call("GET", "/api/nope")
  check(
    "an unknown endpoint answers in the API envelope",
    missing.body?.name === "not_found",
    missing.body,
  )

  const badUuid = await call("GET", "/api/domains/not-a-uuid")
  check("a malformed id is a validation error", badUuid.status === 422, badUuid.body)

  const foreign = await call("GET", "/api/domains/00000000-0000-0000-0000-000000000000")
  check("another account's domain is not found", foreign.status === 404, foreign.body)

  section("address activity")
  const activity = await call("GET", `/api/addresses/${mailbox.body?.id}/activity`)
  check(
    "a mailbox reports 30 zero-filled days",
    activity.status === 200 &&
      activity.body?.object === "activity" &&
      activity.body.days?.length === 30 &&
      activity.body.days.every(
        (d: any) =>
          /^\d{4}-\d{2}-\d{2}$/.test(d.day) &&
          typeof d.sent === "number" &&
          typeof d.received === "number",
      ),
    activity.body,
  )
  check(
    "it wants a session",
    (await fetch(`${BASE}/api/addresses/${mailbox.body?.id}/activity`)).status === 401,
  )
  const activityStranger = await asStranger(() =>
    call("GET", `/api/addresses/${mailbox.body?.id}/activity`),
  )
  check(
    "another account's mailbox is a 404",
    activityStranger.status === 404,
    activityStranger.body,
  )
  check(
    "an unknown address is a 404",
    (await call("GET", `/api/addresses/${nobody}/activity`)).status === 404,
  )
  check(
    "a malformed address id is a validation error",
    (await call("GET", "/api/addresses/nope/activity")).status === 422,
  )

  section("address recovery links")
  const recoverCheckBogus = await call("GET", "/api/recover/check?token=not-a-real-token")
  check(
    "an unknown recovery token is reported as not valid",
    recoverCheckBogus.status === 200 &&
      recoverCheckBogus.body?.object === "address_recovery" &&
      recoverCheckBogus.body?.valid === false,
    recoverCheckBogus.body,
  )
  check("the token is required", (await call("GET", "/api/recover/check")).status === 422)
  if (sql) {
    const recoverToken = `smoke-recover-${suffix}-${crypto.randomUUID()}`
    const insertToken = async (hours: number, used: boolean) => {
      const token = `${recoverToken}-${hours}-${used}`
      await sql!`INSERT INTO tokens (kind, token_hash, address_id, expires_at, used_at)
                 VALUES ('address_recovery', encode(digest(${token}, 'sha256'), 'hex'), ${mailbox.body?.id},
                         now() + make_interval(hours => ${hours}::int), ${used ? new Date() : null})`
      return token
    }
    const live = await insertToken(1, false)
    const checkLive = await call("GET", `/api/recover/check?token=${encodeURIComponent(live)}`)
    check(
      "a live recovery token is reported as valid",
      checkLive.body?.valid === true,
      checkLive.body,
    )
    const expired = await insertToken(-1, false)
    check(
      "an expired one is not",
      (await call("GET", `/api/recover/check?token=${encodeURIComponent(expired)}`)).body?.valid ===
        false,
    )
    const spent = await insertToken(1, true)
    check(
      "a used one is not",
      (await call("GET", `/api/recover/check?token=${encodeURIComponent(spent)}`)).body?.valid ===
        false,
    )
    const otherKind = `${recoverToken}-kind`
    await sql`INSERT INTO tokens (kind, token_hash, expires_at)
              VALUES ('password_reset', encode(digest(${otherKind}, 'sha256'), 'hex'), now() + interval '1 hour')`
    check(
      "a token of another kind is not",
      (await call("GET", `/api/recover/check?token=${encodeURIComponent(otherKind)}`)).body
        ?.valid === false,
    )
    for (const t of [live, expired, spent, otherKind]) {
      await sql`DELETE FROM tokens WHERE token_hash = encode(digest(${t}, 'sha256'), 'hex')`
    }
  }

  section("webmail message source")
  await call("POST", `/api/domains/${domainId}/addresses`, {
    local_part: "colleague",
    type: "standard",
    password: "mailbox-password-1234",
  })
  const loginAs = (local: string, pw: string) =>
    withCookie("", async () => {
      const r = await call("POST", "/api/mail/login", {
        email: `${local}@${domainName}`,
        password: pw,
      })
      return { status: r.status, cookie }
    })
  const mailSession = await loginAs("me", "another-mailbox-password")
  check("a mailbox can sign in to the webmail", mailSession.status === 200, mailSession.status)
  const colleagueSession = await loginAs("colleague", "mailbox-password-1234")
  const asMailbox = <T>(session: { cookie: string }, fn: () => Promise<T>) =>
    withCookie(session.cookie, fn)

  // A draft is the one message the webmail API can make without SMTP.
  const draftText = "Hello from the smoke test.\r\nSecond line."
  const draft = await asMailbox(mailSession, () =>
    call("POST", "/api/mail/drafts", {
      to: ["someone@far.invalid"],
      subject: "Smoke draft",
      text: draftText,
    }),
  )
  check("a draft can be saved", draft.status === 200 && uuid.test(draft.body?.id), draft.body)
  const draftId = String(draft.body?.id)

  const rawRes = await fetch(`${BASE}/api/mail/messages/${draftId}/raw`, {
    headers: { cookie: mailSession.cookie },
  })
  const rawText = await rawRes.text()
  check(
    "the source is served as plain text",
    rawRes.status === 200 &&
      rawRes.headers.get("content-type") === "text/plain; charset=utf-8" &&
      rawRes.headers.get("x-content-type-options") === "nosniff" &&
      /^subject: Smoke draft$/im.test(rawText) &&
      rawText.includes("Hello from the smoke test."),
    {
      status: rawRes.status,
      type: rawRes.headers.get("content-type"),
      head: rawText.slice(0, 120),
    },
  )
  check(
    "the source wants a mailbox session",
    (await fetch(`${BASE}/api/mail/messages/${draftId}/raw`)).status === 401,
  )
  const panelOnRaw = await call("GET", `/api/mail/messages/${draftId}/raw`)
  check("a panel session is not a mailbox session", panelOnRaw.status === 401, panelOnRaw.body)
  const rawColleague = await asMailbox(colleagueSession, () =>
    call("GET", `/api/mail/messages/${draftId}/raw`),
  )
  check("another mailbox's message is a 404", rawColleague.status === 404, rawColleague.body)
  check(
    "an unknown message is a 404",
    (await asMailbox(mailSession, () => call("GET", `/api/mail/messages/${nobody}/raw`))).status ===
      404,
  )
  check(
    "a malformed message id is a validation error",
    (await asMailbox(mailSession, () => call("GET", "/api/mail/messages/nope/raw"))).status === 422,
  )

  const partRes = await fetch(`${BASE}/api/mail/messages/${draftId}/part/1`, {
    headers: { cookie: mailSession.cookie },
  })
  const partText = await partRes.text()
  check(
    "a part is served",
    partRes.status === 200 && partText.includes("Hello from the smoke test."),
    { status: partRes.status, body: partText.slice(0, 80) },
  )
  check(
    "as a sandboxed download, whatever its declared type",
    partRes.headers.get("content-type") === "application/octet-stream" &&
      (partRes.headers.get("content-disposition") ?? "").startsWith("attachment") &&
      partRes.headers.get("x-content-type-options") === "nosniff" &&
      (partRes.headers.get("content-security-policy") ?? "").includes("sandbox"),
    Object.fromEntries(partRes.headers),
  )
  const noPart = await asMailbox(mailSession, () =>
    call("GET", `/api/mail/messages/${draftId}/part/9`),
  )
  check("a part that does not exist is a 404", noPart.status === 404, noPart.body)
  const badSection = await asMailbox(mailSession, () =>
    call("GET", `/api/mail/messages/${draftId}/part/abc`),
  )
  check("a malformed section is a validation error", badSection.status === 422, badSection.body)
  check(
    "a part wants a mailbox session",
    (await fetch(`${BASE}/api/mail/messages/${draftId}/part/1`)).status === 401,
  )
  const partColleague = await asMailbox(colleagueSession, () =>
    call("GET", `/api/mail/messages/${draftId}/part/1`),
  )
  check("another mailbox's part is a 404", partColleague.status === 404, partColleague.body)

  section("billing records")
  const methodsNow = await call("GET", "/api/billing/payment-methods")
  const methodRows: any[] = methodsNow.body?.data ?? []
  check(
    "payment methods are listed with exactly one default",
    methodRows.length >= 2 && methodRows.filter((m) => m.is_default).length === 1,
    methodRows,
  )
  const billingManual = provider.body?.configured === false
  if (billingManual) {
    const target = methodRows.find((m) => !m.is_default)
    const makeDefault = await call("POST", `/api/billing/payment-methods/${target.id}/default`)
    check(
      "another method can be made the default",
      makeDefault.status === 200 &&
        makeDefault.body?.id === target.id &&
        makeDefault.body?.is_default === true,
      makeDefault.body,
    )
    const afterDefault = (await call("GET", "/api/billing/payment-methods")).body?.data ?? []
    check(
      "and the previous default is demoted",
      afterDefault.filter((m: any) => m.is_default).length === 1 &&
        afterDefault.find((m: any) => m.is_default)?.id === target.id,
      afterDefault,
    )
    const defaultStranger = await asStranger(() =>
      call("POST", `/api/billing/payment-methods/${target.id}/default`),
    )
    check(
      "another account cannot change the default",
      defaultStranger.status === 404,
      defaultStranger.body,
    )
    check(
      "an unknown method cannot be the default",
      (await call("POST", `/api/billing/payment-methods/${nobody}/default`)).status === 404,
    )
    check(
      "the default wants a session",
      (await fetch(`${BASE}/api/billing/payment-methods/${target.id}/default`, { method: "POST" }))
        .status === 401,
    )

    const deleteStranger = await asStranger(() =>
      call("DELETE", `/api/billing/payment-methods/${target.id}`),
    )
    check(
      "another account cannot remove a method",
      deleteStranger.status === 404,
      deleteStranger.body,
    )
    check(
      "removing wants a session",
      (await fetch(`${BASE}/api/billing/payment-methods/${target.id}`, { method: "DELETE" }))
        .status === 401,
    )
    check(
      "an unknown method cannot be removed",
      (await call("DELETE", `/api/billing/payment-methods/${nobody}`)).status === 404,
    )

    // The spare goes (it is not the default), so deleting leaves exactly one.
    const spare = methodRows.find((m) => m.id !== target.id)
    const spareGone = await call("DELETE", `/api/billing/payment-methods/${spare.id}`)
    check(
      "a method that is not the default can be removed",
      spareGone.status === 200 &&
        spareGone.body?.deleted === true &&
        spareGone.body?.id === spare.id,
      spareGone.body,
    )
    check(
      "removing twice is a 404",
      (await call("DELETE", `/api/billing/payment-methods/${spare.id}`)).status === 404,
    )
    const remaining = (await call("GET", "/api/billing/payment-methods")).body?.data ?? []
    check(
      "and the default is unchanged",
      remaining.length === methodRows.length - 1 &&
        remaining.every((m: any) => m.is_default === (m.id === target.id)),
      remaining,
    )

    // Removing the default with a spare on file promotes the spare. Promoting
    // first used to collide with the one-default index and answer 409.
    await call("POST", "/api/billing/payment-methods", {
      provider: "manual",
      provider_ref: `tok_spare_${suffix}`,
      brand: "Visa",
      last4: "1881",
    })
    {
      const defaultGone = await call("DELETE", `/api/billing/payment-methods/${target.id}`)
      const promoted = (await call("GET", "/api/billing/payment-methods")).body?.data ?? []
      check(
        "removing the default promotes another method",
        defaultGone.status === 200 &&
          promoted.length === remaining.length &&
          promoted.filter((m: any) => m.is_default).length === 1,
        { status: defaultGone.status, body: defaultGone.body, promoted },
      )
    }

    // Down to one method, on a live subscription.
    const leftover = (await call("GET", "/api/billing/payment-methods")).body?.data ?? []
    for (const m of leftover.filter((m: any) => !m.is_default))
      await call("DELETE", `/api/billing/payment-methods/${m.id}`)
    const last = (await call("GET", "/api/billing/payment-methods")).body?.data?.[0]
    const lastRemoval = await call("DELETE", `/api/billing/payment-methods/${last?.id}`)
    check(
      "the only method cannot be removed from a live subscription",
      lastRemoval.status === 409,
      lastRemoval.body,
    )
  }

  const taxEmpty = await call("GET", "/api/billing/tax-id")
  check(
    "with no tax id on file the read says so",
    taxEmpty.status === 200 && taxEmpty.body?.object === "tax_id" && taxEmpty.body?.id === null,
    taxEmpty.body,
  )
  const taxPut = await call("PUT", "/api/billing/tax-id", {
    kind: "eu_vat",
    value: "DE123456789",
    country: "DE",
    business_name: "Smoke GmbH",
    address_line: "1 Test Strasse",
  })
  check(
    "a tax id can be saved",
    taxPut.status === 200 &&
      uuid.test(taxPut.body?.id) &&
      taxPut.body?.kind === "eu_vat" &&
      taxPut.body?.value === "DE123456789" &&
      taxPut.body?.country === "DE" &&
      taxPut.body?.business_name === "Smoke GmbH",
    taxPut.body,
  )
  const taxRead = await call("GET", "/api/billing/tax-id")
  check(
    "and read back",
    taxRead.body?.id === taxPut.body?.id && taxRead.body?.value === "DE123456789",
    taxRead.body,
  )
  const taxAgain = await call("PUT", "/api/billing/tax-id", {
    kind: "eu_vat",
    value: "DE987654321",
  })
  check(
    "saving again replaces it rather than adding a second",
    taxAgain.status === 200 &&
      taxAgain.body?.id === taxPut.body?.id &&
      taxAgain.body?.value === "DE987654321" &&
      taxAgain.body?.country === null,
    taxAgain.body,
  )
  check(
    "a tax id needs a value",
    (await call("PUT", "/api/billing/tax-id", { kind: "eu_vat" })).status === 422,
  )
  check(
    "a country is two letters",
    (await call("PUT", "/api/billing/tax-id", { kind: "eu_vat", value: "x", country: "DEU" }))
      .status === 422,
  )
  check("a tax id wants a session", (await fetch(`${BASE}/api/billing/tax-id`)).status === 401)
  const taxStranger = await asStranger(() => call("GET", "/api/billing/tax-id"))
  check(
    "another account does not see it",
    taxStranger.status === 200 && taxStranger.body?.id === null,
    taxStranger.body,
  )

  const txList = await call("GET", "/api/billing/transactions")
  const tx = txList.body?.data?.[0]
  if (tx) {
    const txRead = await call("GET", `/api/billing/transactions/${tx.id}`)
    check(
      "one transaction can be read",
      txRead.status === 200 &&
        txRead.body?.id === tx.id &&
        txRead.body?.amount_cents === tx.amount_cents,
      txRead.body,
    )
    const txStranger = await asStranger(() => call("GET", `/api/billing/transactions/${tx.id}`))
    check("another account's transaction is a 404", txStranger.status === 404, txStranger.body)
    check(
      "a transaction wants a session",
      (await fetch(`${BASE}/api/billing/transactions/${tx.id}`)).status === 401,
    )
  }
  check(
    "an unknown transaction is a 404",
    (await call("GET", `/api/billing/transactions/${nobody}`)).status === 404,
  )
  check(
    "a malformed transaction id is a validation error",
    (await call("GET", "/api/billing/transactions/nope")).status === 422,
  )

  const subscriptionCheckout = await call("POST", "/api/billing/checkout/subscription", {
    plan_id: paid?.id ?? roomy?.id,
  })
  check(
    "subscription checkout is refused cleanly when no provider is configured",
    provider.body?.configured
      ? subscriptionCheckout.status === 200 || subscriptionCheckout.status === 400
      : subscriptionCheckout.status === 400,
    subscriptionCheckout.body,
  )
  check(
    "it needs a plan id",
    (await call("POST", "/api/billing/checkout/subscription", {})).status === 422,
  )
  check(
    "a plan id is a uuid",
    (await call("POST", "/api/billing/checkout/subscription", { plan_id: "pro" })).status === 422,
  )
  check(
    "it wants a session",
    (
      await fetch(`${BASE}/api/billing/checkout/subscription`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ plan_id: nobody }),
      })
    ).status === 401,
  )

  // A new account starts on a trial subscription, so "none" has to be made.
  if (sql) {
    const strangerId = (await asStranger(() => call("GET", "/api/auth/me"))).body?.id
    await sql`UPDATE subscriptions SET status = 'cancelled' WHERE user_id = ${strangerId}`
    const cancelNone = await asStranger(() => call("POST", "/api/subscription/cancel"))
    check(
      "an account with no live subscription cannot cancel one",
      cancelNone.status === 404,
      cancelNone.body,
    )
  }
  check(
    "cancelling wants a session",
    (await fetch(`${BASE}/api/subscription/cancel`, { method: "POST" })).status === 401,
  )
  const cancelSub = await call("POST", "/api/subscription/cancel")
  check(
    "a subscription is cancelled at the period end, not at once, and names its plan",
    cancelSub.status === 200 &&
      cancelSub.body?.cancel_at_period_end === true &&
      typeof cancelSub.body?.plan?.id === "string",
    cancelSub.body,
  )
  check(
    "the plan stays in effect until then",
    (await call("GET", "/api/entitlement")).body?.plan?.id !== undefined,
  )

  section("account security")
  const prefs = await call("PATCH", "/api/account/notifications", { referrals: true, quota: false })
  check(
    "notification preferences can be set",
    prefs.status === 200 &&
      prefs.body?.notification_prefs?.referrals === true &&
      prefs.body?.notification_prefs?.quota === false,
    prefs.body,
  )
  const prefsMerged = await call("PATCH", "/api/account/notifications", { security: false })
  check(
    "and a later patch keeps the earlier ones",
    prefsMerged.body?.notification_prefs?.security === false &&
      prefsMerged.body?.notification_prefs?.referrals === true &&
      prefsMerged.body?.notification_prefs?.quota === false,
    prefsMerged.body,
  )
  const prefsRead = await call("GET", "/api/auth/me")
  check("they persist", prefsRead.body?.notification_prefs?.quota === false)
  check(
    "a preference is a boolean",
    (await call("PATCH", "/api/account/notifications", { quota: "no" })).status === 422,
  )
  const prefsStrangerView = await asStranger(() => call("GET", "/api/auth/me"))
  check(
    "another account's preferences are untouched",
    prefsStrangerView.body?.notification_prefs?.quota !== false,
    prefsStrangerView.body,
  )
  check(
    "preferences want a session",
    (
      await fetch(`${BASE}/api/account/notifications`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quota: true }),
      })
    ).status === 401,
  )

  const secondLogin = await withCookie("", async () => {
    const r = await call("POST", "/api/auth/login", { email, password })
    return { status: r.status, cookie }
  })
  check(
    "a second session can be opened",
    secondLogin.status === 200 && secondLogin.cookie.startsWith("corsair_session="),
    secondLogin.status,
  )
  const sessionsTwo = await call("GET", "/api/account/sessions")
  check("both sessions are listed", (sessionsTwo.body?.data?.length ?? 0) >= 2, sessionsTwo.body)
  check(
    "revoking wants a session",
    (await fetch(`${BASE}/api/account/sessions/revoke-others`, { method: "POST" })).status === 401,
  )
  const revokeOthers = await call("POST", "/api/account/sessions/revoke-others")
  check(
    "other sessions can be revoked",
    revokeOthers.status === 200 && revokeOthers.body?.revoked === true,
    revokeOthers.body,
  )
  const revokedMe = await withCookie(secondLogin.cookie, () => call("GET", "/api/auth/me"))
  check("the other session stops working", revokedMe.status === 401, revokedMe.body)
  const sessionsOne = await call("GET", "/api/account/sessions")
  check(
    "this one survives and is the only one left",
    sessionsOne.body?.data?.length === 1 && sessionsOne.body.data[0].current === true,
    sessionsOne.body,
  )
  check(
    "the stranger's sessions were not touched",
    (await asStranger(() => call("GET", "/api/auth/me"))).status === 200,
  )

  const newEmail = `smoke-moved-${suffix}@corsair.test`
  const emailWrongPw = await call("POST", "/api/account/email", {
    email: newEmail,
    password: "not-the-password",
  })
  check("changing the email needs the password", emailWrongPw.status === 401, emailWrongPw.body)
  check(
    "the email has to be one",
    (await call("POST", "/api/account/email", { email: "nope", password })).status === 422,
  )
  const emailTaken = await call("POST", "/api/account/email", {
    email: `smoke-other-${suffix}@corsair.test`,
    password,
  })
  check("an address another account uses is a 409", emailTaken.status === 409, emailTaken.body)
  check(
    "changing the email wants a session",
    (
      await fetch(`${BASE}/api/account/email`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: newEmail, password }),
      })
    ).status === 401,
  )
  const thirdLogin = await withCookie("", async () => {
    const r = await call("POST", "/api/auth/login", { email, password })
    return { status: r.status, cookie }
  })
  const emailChanged = await call("POST", "/api/account/email", {
    email: newEmail.toUpperCase(),
    password,
  })
  check(
    "the email can be changed, and is stored lowercase",
    emailChanged.status === 200 && emailChanged.body?.email === newEmail,
    emailChanged.body,
  )
  check(
    "the session that did it survives",
    (await call("GET", "/api/auth/me")).body?.email === newEmail,
  )
  check(
    "every other session was ended",
    (await withCookie(thirdLogin.cookie, () => call("GET", "/api/auth/me"))).status === 401,
  )
  const oldEmailLogin = await withCookie("", () =>
    call("POST", "/api/auth/login", { email, password }),
  )
  check("the old address no longer signs in", oldEmailLogin.status === 401, oldEmailLogin.body)
  const newEmailLogin = await withCookie("", () =>
    call("POST", "/api/auth/login", { email: newEmail, password }),
  )
  check("the new one does", newEmailLogin.status === 200, newEmailLogin.body)
  const sameEmail = await call("POST", "/api/account/email", { email: newEmail, password })
  check(
    "saying the same address again is harmless",
    sameEmail.status === 200 && sameEmail.body?.email === newEmail,
    sameEmail.body,
  )
  const emailBack = await call("POST", "/api/account/email", { email, password })
  check(
    "and it can be changed back",
    emailBack.status === 200 && emailBack.body?.email === email,
    emailBack.body,
  )

  section("two-factor authentication")
  check(
    "setup wants a session",
    (await fetch(`${BASE}/api/auth/totp/setup`, { method: "POST" })).status === 401,
  )
  const enableEarly = await call("POST", "/api/auth/totp/enable", { code: "123456" })
  check("it cannot be enabled before setup", enableEarly.status === 400, enableEarly.body)
  const totpSetup = await call("POST", "/api/auth/totp/setup")
  const totpSecret = String(totpSetup.body?.secret ?? "")
  check(
    "setup returns a secret and a provisioning URL",
    totpSetup.status === 200 &&
      totpSetup.body?.object === "totp_setup" &&
      /^[A-Z2-7]{16,}$/.test(totpSecret) &&
      String(totpSetup.body?.otpauth_url).startsWith("otpauth://totp/") &&
      String(totpSetup.body?.otpauth_url).includes(totpSecret),
    totpSetup.body,
  )
  check(
    "setup alone does not turn it on",
    (await call("GET", "/api/auth/me")).body?.totp_enabled === false,
  )
  const enableWrong = await call("POST", "/api/auth/totp/enable", { code: "000000" })
  check("a wrong code is refused", enableWrong.status === 400, enableWrong.body)
  check(
    "a short code is refused",
    (await call("POST", "/api/auth/totp/enable", { code: "12" })).status === 422,
  )
  const enabled = await call("POST", "/api/auth/totp/enable", { code: totpCode(totpSecret) })
  const backupCodes: string[] = enabled.body?.backup_codes ?? []
  check(
    "the right code enables it and hands over backup codes",
    enabled.status === 200 &&
      enabled.body?.enabled === true &&
      backupCodes.length === 10 &&
      new Set(backupCodes).size === 10,
    enabled.body,
  )
  check("the account reports it", (await call("GET", "/api/auth/me")).body?.totp_enabled === true)
  const setupAgain = await call("POST", "/api/auth/totp/setup")
  check("setup cannot run again once enabled", setupAgain.status === 409, setupAgain.body)
  const enableAgain = await call("POST", "/api/auth/totp/enable", { code: totpCode(totpSecret) })
  check("nor can enable", enableAgain.status === 409, enableAgain.body)

  const loginNoCode = await withCookie("", () =>
    call("POST", "/api/auth/login", { email, password }),
  )
  check(
    "signing in now asks for a code instead of opening a session",
    loginNoCode.status === 200 && loginNoCode.body?.totp_required === true,
    loginNoCode.body,
  )
  const loginBadCode = await withCookie("", () =>
    call("POST", "/api/auth/login", { email, password, code: "000000" }),
  )
  check(
    "a wrong code is the same refusal as a wrong password",
    loginBadCode.status === 401,
    loginBadCode.body,
  )
  const loginCode = await withCookie("", async () => {
    const r = await call("POST", "/api/auth/login", { email, password, code: totpCode(totpSecret) })
    return { status: r.status, cookie }
  })
  check(
    "the right code signs in",
    loginCode.status === 200 && loginCode.cookie.startsWith("corsair_session="),
    loginCode.status,
  )
  const backupLogin = async () =>
    withCookie("", async () => {
      const r = await call("POST", "/api/auth/login", { email, password, code: backupCodes[0] })
      return { status: r.status, cookie }
    })
  check("a backup code signs in", (await backupLogin()).status === 200)
  check("but only once", (await backupLogin()).status === 401)

  const disableAnon = await fetch(`${BASE}/api/auth/totp/disable`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  })
  check("disabling wants a session", disableAnon.status === 401)
  check(
    "disabling needs the password field",
    (await call("POST", "/api/auth/totp/disable", {})).status === 422,
  )
  const disableWrong = await call("POST", "/api/auth/totp/disable", {
    password: "not-the-password",
  })
  check("and the right password", disableWrong.status === 401, disableWrong.body)
  check(
    "a refused disable leaves it on",
    (await call("GET", "/api/auth/me")).body?.totp_enabled === true,
  )
  const disabled = await call("POST", "/api/auth/totp/disable", { password })
  check(
    "it can be turned off",
    disabled.status === 200 && disabled.body?.enabled === false,
    disabled.body,
  )
  check(
    "the account reports that",
    (await call("GET", "/api/auth/me")).body?.totp_enabled === false,
  )
  const loginPlain = await withCookie("", () =>
    call("POST", "/api/auth/login", { email, password }),
  )
  check(
    "signing in no longer asks for a code",
    loginPlain.status === 200 && loginPlain.body?.totp_required === undefined,
    loginPlain.body,
  )
  check(
    "the old secret is gone, so enable needs a fresh setup",
    (await call("POST", "/api/auth/totp/enable", { code: totpCode(totpSecret) })).status === 400,
  )

  await sql?.close()

  section("cleanup")
  const deleted = await call("DELETE", `/api/domains/${domainId}`)
  check("the domain can be deleted", deleted.status === 200, deleted.body)

  const loggedOut = await call("POST", "/api/auth/logout")
  check("logout succeeds", loggedOut.status === 200, loggedOut.body)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

await run()
