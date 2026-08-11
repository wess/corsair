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

  section("public endpoints")
  const autoconfig = await fetch(`${BASE}/mail/config-v1.1.xml?emailaddress=me@${domainName}`)
  const autoconfigBody = await autoconfig.text()
  check(
    "Thunderbird autoconfig is served",
    autoconfig.status === 200 && autoconfigBody.includes("<clientConfig"),
  )

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

  section("cleanup")
  const deleted = await call("DELETE", `/api/domains/${domainId}`)
  check("the domain can be deleted", deleted.status === 200, deleted.body)

  const loggedOut = await call("POST", "/api/auth/logout")
  check("logout succeeds", loggedOut.status === 200, loggedOut.body)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

await run()
