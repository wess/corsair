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

const call = async (method: string, path: string, cookie: string, body?: unknown) => {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

const PW = "drive-password-9911"
const suffix = Math.random().toString(36).slice(2, 8)
const zone = `drive-${suffix}.invalid`

const login = async (email: string): Promise<string> => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PW }),
  })
  return (res.headers.get("set-cookie") ?? "").split(";")[0] ?? ""
}

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
