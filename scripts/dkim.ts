import { closeDb } from "../src/db/index.ts"
import { advance, startRotation, status, stragglers } from "../src/dkimrotate/index.ts"

/**
 * DKIM rotation from the operator's side.
 *
 *   bun scripts/dkim.ts status    # phases, and the TXT records to publish
 *   bun scripts/dkim.ts rotate    # stage a new key on the next selector host
 *   bun scripts/dkim.ts advance   # one worker pass now, instead of waiting for it
 *
 * Corsair cannot publish at the selector hosts: they are in your zone, and the
 * DNS tokens it is handed are for customers' zones and are never stored. So this
 * prints what to publish, and the worker moves on once DNS shows it.
 */

const statusReport = async () => {
  for (const h of await status()) {
    const dns = h.dns ? `dns ${h.dns}` : "no record"
    console.log(`${h.selector}  ${h.host}  ${h.phase}  (${dns}, ${h.signers} domain(s) signing)`)
    if (h.action) console.log(`    -> ${h.action}`)
  }
  const late = await stragglers()
  if (late.length) {
    console.log("\nstill on an older selector (kept until their own record resolves):")
    for (const l of late) console.log(`  ${l.domain}  ${l.selector}  dns ${l.dns}`)
  }
}

const run = async () => {
  switch (process.argv[2] ?? "status") {
    case "status":
      await statusReport()
      break
    case "rotate": {
      const started = await startRotation()
      console.log(`staged a new key on ${started.host}. Publish this, then wait:\n`)
      console.log(`  ${started.host}  TXT  ${started.record}\n`)
      console.log("The worker activates it after DKIM_SOAK_HOURS once the record resolves.")
      break
    }
    case "advance":
      for (const line of await advance()) console.log(line)
      break
    default:
      console.error("expected: status | rotate | advance")
      process.exitCode = 1
  }
}

run()
  .catch((e) => {
    console.error((e as Error).message)
    process.exitCode = 1
  })
  .finally(closeDb)
