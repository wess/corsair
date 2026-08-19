/**
 * Administration, end to end against a running server.
 *
 *   bun run test:admins
 *
 * The unit tests in `access.test.ts` cover the helpers; this drives the same
 * rules over HTTP, where the pipes, the route registration order, and the
 * serializers actually run. Most of it is negative: every "cannot" below is a
 * grant that would otherwise hand somebody else's domain to a delegate, and a
 * mistake in wiring — not in the helper — is how that happens.
 */
import { from } from "@atlas/db"
import { createAddress } from "../src/addresses/index.ts"
import { hashPassword } from "../src/auth/index.ts"
import { closeDb, db } from "../src/db/index.ts"
import { type Domain, users } from "../src/schema/index.ts"

const BASE = process.env.CORSAIR_URL ?? "http://localhost:3000"
let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  if (ok) {
    passed++
    console.log(`  ok    ${label}`)
    return
  }
  failed++
  console.log(`  FAIL  ${label}`, detail ?? "")
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Retries a 429 rather than reporting it.
 *
 * The API rate limit is per principal per second, and this file drives dozens
 * of calls as three accounts back to back. Without this the failures land on
 * whichever assertion happened to be in the burst, which reads exactly like an
 * authorization bug and is not one.
 */
const call = async (
  method: string,
  path: string,
  cookie: string,
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
    await sleep(1000)
    return call(method, path, cookie, body, attempt + 1)
  }
  return { status: res.status, body: await res.json().catch(() => null) }
}

const PW = "drive-password-9911"
const suffix = Math.random().toString(36).slice(2, 8)
const zone = `drive-${suffix}.invalid`

/**
 * Signs in, retrying a rate-limited attempt.
 *
 * `publicLimit` is a handful of auth calls per second per IP, and this file
 * makes many. A 429 read as a failure would be bad enough on a positive
 * assertion; on a negative one — "the panel must refuse this credential" — it
 * would make the test pass without ever exercising the rule.
 */
const authPost = async (
  path: string,
  body: unknown,
  attempt = 0,
): Promise<{ status: number; cookie: string }> => {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (res.status === 429 && attempt < 8) {
    await sleep(1000)
    return authPost(path, body, attempt + 1)
  }
  return { status: res.status, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "" }
}

const login = async (email: string): Promise<string> =>
  (await authPost("/api/auth/login", { email, password: PW })).cookie

const mk = async (email: string) =>
  (await db().one<{ id: string }>({
    text: `INSERT INTO users (email, password_hash, name, referral_code, email_verified_at)
           VALUES ($1,$2,'Drive',$3, now()) RETURNING id`,
    values: [email, await hashPassword(PW), Math.random().toString(36).slice(2, 12)],
  }))!.id

const ownerId = await mk(`owner-${suffix}@${zone}`)
const delegateId = await mk(`delegate-${suffix}@${zone}`)
const strangerId = await mk(`stranger-${suffix}@${zone}`)

const domain = (await db().one<Domain>({
  text: `INSERT INTO domains (user_id, name, verification_token, status)
         VALUES ($1,$2,'mail-host-verify=drive','active') RETURNING *`,
  values: [ownerId, zone],
}))!

const ownerC = await login(`owner-${suffix}@${zone}`)
const delegateC = await login(`delegate-${suffix}@${zone}`)
const strangerC = await login(`stranger-${suffix}@${zone}`)

console.log("\nsystem admin grants")
const notOwner = await call("GET", "/api/admins", ownerC)
check("a non-instance-owner cannot list server admins", notOwner.status === 403, notOwner.status)
const grantSys = await call("POST", "/api/admins", ownerC, { email: `delegate-${suffix}@${zone}` })
check("nor grant one", grantSys.status === 403, grantSys.status)

console.log("\ndomain admin grants")
const granted = await call("POST", `/api/domains/${domain.id}/admins`, ownerC, {
  email: `delegate-${suffix}@${zone}`,
})
check("the domain owner may appoint a delegate", granted.status === 201, granted.body)
const again = await call("POST", `/api/domains/${domain.id}/admins`, ownerC, {
  email: `delegate-${suffix}@${zone}`,
})
check("granting twice is idempotent", again.status === 201, again.status)
const byStranger = await call("POST", `/api/domains/${domain.id}/admins`, strangerC, {
  email: `stranger-${suffix}@${zone}`,
})
check("a stranger cannot appoint anyone", byStranger.status === 404, byStranger.status)
const byDelegate = await call("POST", `/api/domains/${domain.id}/admins`, delegateC, {
  email: `stranger-${suffix}@${zone}`,
})
check("a delegate cannot appoint anyone", byDelegate.status === 404, byDelegate.status)

console.log("\nwhat a delegate can do")
const list = await call("GET", "/api/domains", delegateC)
check(
  "the domain shows in their list",
  (list.body?.data ?? []).some((d: any) => d.id === domain.id),
  list.body,
)
const detail = await call("GET", `/api/domains/${domain.id}`, delegateC)
check("they can open the domain", detail.status === 200, detail.status)
check(
  "and are told they cannot manage it",
  detail.body?.can_manage_domain === false,
  detail.body?.can_manage_domain,
)
const made = await call("POST", `/api/domains/${domain.id}/addresses`, delegateC, {
  local_part: "hired",
  type: "standard",
  password: "new-mailbox-pw-771",
})
check("they can add a mailbox", made.status === 201, made.body)
const pw = await call("POST", `/api/addresses/${made.body?.id}/password`, delegateC, {
  password: "reset-by-admin-882",
})
check("and change its password", pw.status === 200, pw.body)

console.log("\nwhat a delegate cannot do")
const linked = await call("POST", `/api/domains/${domain.id}/addresses`, delegateC, {
  local_part: "linked",
  type: "standard",
  use_account_password: true,
})
check("cannot bind a mailbox to their own account password", linked.status === 400, linked.body)
const del = await call("DELETE", `/api/domains/${domain.id}`, delegateC)
check("cannot delete the domain", del.status === 404, del.status)
const patch = await call("PATCH", `/api/domains/${domain.id}`, delegateC, {
  self_service_enabled: true,
})
check("cannot change domain settings", patch.status === 404, patch.status)
const admins = await call("GET", `/api/domains/${domain.id}/admins`, delegateC)
check("cannot see who else administers it", admins.status === 404, admins.status)

console.log("\nwhat a stranger cannot do")
const sList = await call("GET", "/api/domains", strangerC)
check(
  "the domain is invisible",
  !(sList.body?.data ?? []).some((d: any) => d.id === domain.id),
  sList.body?.data?.length,
)
const sAdd = await call("POST", `/api/domains/${domain.id}/addresses`, strangerC, {
  local_part: "nope",
  type: "standard",
  password: "nope-password-123",
})
check("cannot add a mailbox", sAdd.status === 404, sAdd.status)

console.log("\ncreating an account to delegate to")
const noAccount = await call("POST", `/api/domains/${domain.id}/admins`, ownerC, {
  email: `fresh-${suffix}@${zone}`,
})
check("granting to an address with no account is refused", noAccount.status === 404, noAccount.body)
const madeUser = await call("POST", "/api/users", ownerC, {
  email: `fresh-${suffix}@${zone}`,
  password: PW,
})
check("a non-instance-owner cannot create accounts", madeUser.status === 403, madeUser.status)

console.log("\nwhat a delegate may read")
const dns = await call("GET", `/api/domains/${domain.id}/dns`, delegateC)
check("a delegate can read the expected DNS records", dns.status === 200, dns.status)
const zoneFile = await call("GET", `/api/domains/${domain.id}/dns/zone`, delegateC)
check("and the zone file", zoneFile.status === 200, zoneFile.status)
const keys = await call("GET", `/api/domains/${domain.id}/keys`, delegateC)
check("and the DKIM keys", keys.status === 200, keys.status)
const recheck = await call("POST", `/api/domains/${domain.id}/check`, delegateC)
check("and can re-run the DNS check", recheck.status === 200, recheck.status)

console.log("\nbut still not change the domain")
// Bodies have to be well formed, or validation answers before authorization
// does and the assertion proves nothing.
const publish = await call("POST", `/api/domains/${domain.id}/dns/publish`, delegateC, {
  provider: "digitalocean",
  token: "not-a-real-token-but-well-formed",
})
check("cannot publish DNS", publish.status === 404, publish.status)
const rotate = await call(
  "POST",
  `/api/domains/${domain.id}/keys/00000000-0000-0000-0000-000000000000/activate`,
  delegateC,
)
check("cannot rotate a DKIM key", rotate.status === 404, rotate.status)

console.log("\na mailbox as the delegate")
// The case this exists for: the person running a client's mail is a mailbox on
// that domain, with no panel account and no second password.
const runner = `runner-${suffix}`
const RUNNER_PW = "runner-mailbox-pw-4412"
const runnerBox = await call("POST", `/api/domains/${domain.id}/addresses`, ownerC, {
  local_part: runner,
  type: "standard",
  password: RUNNER_PW,
})
check("the owner creates their mailbox", runnerBox.status === 201, runnerBox.body)

const grantBox = await call("POST", `/api/domains/${domain.id}/admins`, ownerC, {
  email: `${runner}@${zone}`,
})
check(
  "granting resolves the mailbox, not an account",
  grantBox.body?.subject === "mailbox",
  grantBox.body,
)

const mailLogin = await authPost("/api/mail/login", {
  email: `${runner}@${zone}`,
  password: RUNNER_PW,
})
const runnerC = mailLogin.cookie
check(
  "they sign into webmail with the one password they have",
  mailLogin.status === 200,
  mailLogin.status,
)

const runnerMe = await call("GET", "/api/mail/me", runnerC)
check(
  "the session reports the domain they administer",
  (runnerMe.body?.administers ?? []).some((d: any) => d.id === domain.id),
  runnerMe.body?.administers,
)

const runnerList = await call("GET", `/api/mail/admin/domains/${domain.id}/users`, runnerC)
check("they can list the domain's mailboxes", runnerList.status === 200, runnerList.status)

const runnerAdd = await call("POST", `/api/mail/admin/domains/${domain.id}/users`, runnerC, {
  local_part: `added-by-${runner}`,
  type: "standard",
  password: "created-in-webmail-88",
})
check("and add one from inside webmail", runnerAdd.status === 201, runnerAdd.body)

const runnerPw = await call(
  "POST",
  `/api/mail/admin/users/${runnerAdd.body?.id}/password`,
  runnerC,
  {
    password: "reset-in-webmail-99",
  },
)
check("and reset its password", runnerPw.status === 200, runnerPw.body)

const runnerDisable = await call("PATCH", `/api/mail/admin/users/${runnerAdd.body?.id}`, runnerC, {
  disabled: true,
})
check("and disable it", runnerDisable.status === 200, runnerDisable.status)

console.log("\nwhat the mailbox delegate must never reach")
const runnerPanel = await authPost("/api/auth/login", {
  email: `${runner}@${zone}`,
  password: RUNNER_PW,
})
check(
  "the mailbox credential does not open the control panel",
  runnerPanel.status === 401,
  runnerPanel.status,
)

const runnerSelfDisable = await call(
  "PATCH",
  `/api/mail/admin/users/${runnerBox.body?.id}`,
  runnerC,
  {
    disabled: true,
  },
)
check(
  "cannot disable their own mailbox",
  runnerSelfDisable.status === 400,
  runnerSelfDisable.status,
)
const runnerSelfDelete = await call(
  "DELETE",
  `/api/mail/admin/users/${runnerBox.body?.id}`,
  runnerC,
)
check("cannot delete their own mailbox", runnerSelfDelete.status === 400, runnerSelfDelete.status)

// A second domain they have nothing to do with.
const otherDomain = (await db().one<Domain>({
  text: `INSERT INTO domains (user_id, name, verification_token, status)
         VALUES ($1,$2,'mail-host-verify=other','active') RETURNING *`,
  values: [strangerId, `other-${suffix}.invalid`],
}))!
const runnerOther = await call("GET", `/api/mail/admin/domains/${otherDomain.id}/users`, runnerC)
check(
  "cannot reach a domain they do not administer",
  runnerOther.status === 404,
  runnerOther.status,
)

console.log("\nan ordinary mailbox sees none of it")
const plain = `plain-${suffix}`
// Created directly rather than through the route: by this point the owner is at
// their plan's address limit — which the delegated route enforced correctly a
// few lines above — and this mailbox is a fixture, not the thing under test.
await createAddress({
  domainId: domain.id,
  localPart: plain,
  type: "standard",
  password: "plain-mailbox-pw-771",
})
const plainLogin = await authPost("/api/mail/login", {
  email: `${plain}@${zone}`,
  password: "plain-mailbox-pw-771",
})
check("an ordinary mailbox signs in", plainLogin.status === 200, plainLogin.status)
const plainC = plainLogin.cookie
const plainMe = await call("GET", "/api/mail/me", plainC)
check(
  "no domains to administer",
  (plainMe.body?.administers ?? []).length === 0,
  plainMe.body?.administers,
)
const plainReach = await call("GET", `/api/mail/admin/domains/${domain.id}/users`, plainC)
check("and the management routes refuse them", plainReach.status === 404, plainReach.status)

console.log("\nrevoking")
const revoked = await call("DELETE", `/api/domains/${domain.id}/admins/${delegateId}`, ownerC)
check("the owner can revoke", revoked.status === 200, revoked.body)
const afterRevoke = await call("POST", `/api/domains/${domain.id}/addresses`, delegateC, {
  local_part: "after",
  type: "standard",
  password: "after-password-123",
})
check("the delegate loses access immediately", afterRevoke.status === 404, afterRevoke.status)

for (const id of [ownerId, delegateId, strangerId]) {
  await db().execute(
    from(users)
      .where((q) => q("id").equals(id))
      .del(),
  )
}
console.log(`\n${passed} passed, ${failed} failed`)
await closeDb()
process.exit(failed ? 1 : 0)
