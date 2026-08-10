import { migrate } from "@atlas/migrate"
import { closeDb, db } from "../src/db/index.ts"
import { allSchemas } from "../src/schema/index.ts"

/**
 * Schema management, deliberately separate from the serving processes: two
 * instances coming up at once would race on the migration table, and this is
 * the one step worth being able to run — and fail — on its own.
 *
 *   bun scripts/migrate.ts up | down | status | diff
 */

const DIR = "./migrations"

const run = async () => {
  const conn = db()
  switch (process.argv[2] ?? "up") {
    case "up": {
      const ran = await migrate.up(conn, DIR)
      console.log(ran.length ? `applied: ${ran.join(", ")}` : "no pending migrations")
      break
    }
    case "down": {
      const rolled = await migrate.down(conn, DIR)
      console.log(rolled ? `rolled back: ${rolled}` : "nothing to roll back")
      break
    }
    case "status": {
      for (const row of await migrate.status(conn, DIR)) {
        console.log(`${row.appliedAt ? "applied" : "pending"}  ${row.name}`)
      }
      break
    }
    case "diff": {
      const result = await migrate.diff(conn, allSchemas as never, { dir: DIR })
      console.log(result.noop ? "schema in sync" : `wrote ${result.path}`)
      break
    }
    default:
      console.error("expected: up | down | status | diff")
      process.exitCode = 1
  }
  await closeDb()
}

await run()
