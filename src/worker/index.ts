import { randomUUID } from "node:crypto"
import { from } from "@atlas/db"
import { config } from "../config/index.ts"
import { db } from "../db/index.ts"
import { checkDomain } from "../domains/index.ts"
import { emit } from "../events/index.ts"
import { type Domain, domains, type Job, jobs, type Transfer, transfers } from "../schema/index.ts"
import { drain, releaseStale } from "../smtp/index.ts"
import { recomputeUsage } from "../store/index.ts"
import { runTransfer } from "./transfer/index.ts"
import { drainWebhooks, releaseStaleWebhooks } from "./webhook/index.ts"

export { runTransfer } from "./transfer/index.ts"
export { deliverEvent, drainWebhooks, replayEvent } from "./webhook/index.ts"

const WORKER_ID = `${process.pid}-${randomUUID().slice(0, 8)}`

export type JobKind = "domain.verify" | "transfer.run" | "quota.recompute" | "retention.sweep"

export const enqueueJob = async (input: {
  kind: JobKind
  payload: Record<string, unknown>
  userId?: string | null
  runAt?: Date
}): Promise<void> => {
  await db().execute(
    from(jobs).insert({
      kind: input.kind,
      payload: input.payload,
      user_id: input.userId ?? null,
      ...(input.runAt ? { run_at: input.runAt } : {}),
    }),
  )
}

/** Same SKIP LOCKED claim as the delivery queue, for the same reason. */
const claimJobs = async (limit: number): Promise<Job[]> =>
  db().all<Job>({
    text: `UPDATE jobs SET status = 'running', locked_at = now(), locked_by = $1,
                           attempts = attempts + 1, updated_at = now()
            WHERE id IN (
              SELECT id FROM jobs
               WHERE status = 'pending' AND run_at <= now()
               ORDER BY run_at
               LIMIT $2
               FOR UPDATE SKIP LOCKED
            )
        RETURNING *`,
    values: [WORKER_ID, limit],
  })

const finish = async (job: Job, error?: string): Promise<void> => {
  if (!error) {
    await db().execute(
      from(jobs)
        .where((q) => q("id").equals(job.id))
        .update({ status: "done", locked_at: null, locked_by: null, updated_at: new Date() }),
    )
    return
  }

  const exhausted = job.attempts >= job.max_attempts
  await db().execute(
    from(jobs)
      .where((q) => q("id").equals(job.id))
      .update({
        status: exhausted ? "failed" : "pending",
        // Exponential backoff, capped so a permanently broken job still gets
        // retried occasionally rather than every second.
        run_at: new Date(Date.now() + Math.min(2 ** job.attempts, 300) * 1000),
        last_error: error.slice(0, 2000),
        locked_at: null,
        locked_by: null,
        updated_at: new Date(),
      }),
  )
}

const runJob = async (job: Job): Promise<void> => {
  switch (job.kind) {
    case "domain.verify": {
      const domain = await db().one<Domain>(
        from(domains).where((q) => q("id").equals(String(job.payload.domain_id))),
      )
      if (!domain) return
      const wasActive = domain.status === "active"
      const result = await checkDomain(domain)
      console.log(
        `[corsair] dns check ${domain.name}: ${result.ready ? "active" : "still pending"}`,
      )

      // Only on a transition. Emitting "still pending" every half hour for a
      // domain nobody has finished setting up is noise, not a notification.
      if (result.ready !== wasActive) {
        void emit({
          userId: domain.user_id,
          domainId: domain.id,
          type: result.ready ? "domain.verified" : "domain.verification_failed",
          data: {
            domain: domain.name,
            records: result.records
              .filter((r) => r.required)
              .map((r) => ({ type: r.type, host: r.host, status: r.status })),
          },
        })
      }
      // Keep re-checking a pending domain: customers publish records hours after
      // adding a domain and never come back to press the button.
      if (!result.ready) {
        await enqueueJob({
          kind: "domain.verify",
          payload: { domain_id: domain.id },
          userId: domain.user_id,
          runAt: new Date(Date.now() + 30 * 60_000),
        })
      }
      return
    }

    case "transfer.run": {
      const transfer = await db().one<Transfer>(
        from(transfers).where((q) => q("id").equals(String(job.payload.transfer_id))),
      )
      if (!transfer || transfer.status === "cancelled") return
      try {
        await runTransfer(transfer)
      } catch (e) {
        await db().execute(
          from(transfers)
            .where((q) => q("id").equals(transfer.id))
            .update({
              status: "failed",
              last_error: (e as Error).message.slice(0, 1000),
              finished_at: new Date(),
              updated_at: new Date(),
            }),
        )
        throw e
      }
      return
    }

    case "quota.recompute": {
      const addressId = job.payload.address_id
      if (typeof addressId === "string") {
        await recomputeUsage(addressId)
        return
      }
      // No address named: recompute everything. Runs from the periodic sweep,
      // where the accounting is reconciled against what is actually stored.
      const rows = await db().all<{ id: string }>({
        text: "SELECT id FROM addresses",
        values: [],
      })
      for (const row of rows) await recomputeUsage(row.id)
      await db().execute({
        text: `UPDATE domains d SET bytes_used = coalesce(sub.total, 0)
                 FROM (SELECT domain_id, sum(bytes_used) AS total FROM addresses GROUP BY domain_id) sub
                WHERE d.id = sub.domain_id`,
        values: [],
      })
      return
    }

    case "retention.sweep": {
      // Tombstones exist so a reconnecting client can be told what vanished.
      // After a month no client is that far behind, and they are pure overhead.
      const tombstones = await db().all<{ id: string }>({
        text: `DELETE FROM message_tombstones WHERE created_at < now() - interval '30 days'
               RETURNING id`,
        values: [],
      })
      const expunged = await db().all<{ id: string }>({
        text: `DELETE FROM messages WHERE expunged_at IS NOT NULL
                 AND expunged_at < now() - interval '30 days'
               RETURNING id`,
        values: [],
      })
      const logs = await db().all<{ id: string }>({
        text: `DELETE FROM mail_log WHERE created_at < now() - interval '90 days' RETURNING id`,
        values: [],
      })
      await db().execute({
        text: "DELETE FROM auth_failures WHERE created_at < now() - interval '7 days'",
        values: [],
      })
      await db().execute({
        text: "DELETE FROM bans WHERE expires_at < now()",
        values: [],
      })
      await db().execute({
        text: "DELETE FROM sessions WHERE expires_at < now() - interval '30 days'",
        values: [],
      })
      await db().execute({
        text: "DELETE FROM tokens WHERE expires_at < now() - interval '7 days'",
        values: [],
      })
      await db().execute({
        text: `DELETE FROM deliveries WHERE status IN ('sent', 'failed')
                 AND updated_at < now() - interval '14 days'`,
        values: [],
      })
      if (tombstones.length || expunged.length || logs.length) {
        console.log(
          `[corsair] retention sweep: ${expunged.length} message(s), ${tombstones.length} tombstone(s), ${logs.length} log row(s)`,
        )
      }
      return
    }

    default:
      throw new Error(`unknown job kind: ${job.kind}`)
  }
}

let running = false
let timers: ReturnType<typeof setInterval>[] = []

export const tick = async (): Promise<void> => {
  const claimed = await claimJobs(config.worker.concurrency)
  await Promise.all(
    claimed.map(async (job) => {
      try {
        await runJob(job)
        await finish(job)
      } catch (e) {
        console.error(`[corsair] job ${job.kind} failed:`, (e as Error).message)
        await finish(job, (e as Error).message)
      }
    }),
  )
}

/**
 * Schedules the periodic work that nobody enqueues.
 *
 * Guarded by a Postgres advisory lock so that several workers can run without
 * all of them starting the same sweep — the lock is released when the
 * connection drops, which is exactly the behaviour a crashed worker needs.
 */
const periodic = async (kind: JobKind, lockKey: number): Promise<void> => {
  const row = await db().one<{ locked: boolean }>({
    text: "SELECT pg_try_advisory_lock($1) AS locked",
    values: [lockKey],
  })
  if (!row?.locked) return
  try {
    await enqueueJob({ kind, payload: {} })
  } finally {
    await db().execute({ text: "SELECT pg_advisory_unlock($1)", values: [lockKey] })
  }
}

export const startWorker = async (): Promise<void> => {
  if (running) return
  running = true

  console.log(`[corsair] worker      ${WORKER_ID}`)

  timers.push(
    setInterval(() => {
      void tick().catch((e) => console.error("[corsair] worker tick failed:", e))
    }, config.worker.pollMs),
  )

  timers.push(
    setInterval(() => {
      void drain().catch((e) => console.error("[corsair] delivery drain failed:", e))
    }, config.worker.pollMs),
  )

  timers.push(
    setInterval(() => {
      void drainWebhooks().catch((e) => console.error("[corsair] webhook drain failed:", e))
    }, config.worker.pollMs),
  )

  timers.push(
    setInterval(() => {
      void releaseStale().catch(() => {})
      void releaseStaleWebhooks().catch(() => {})
      void periodic("retention.sweep", 4711).catch(() => {})
    }, 15 * 60_000),
  )

  timers.push(
    setInterval(
      () => {
        void periodic("quota.recompute", 4712).catch(() => {})
      },
      6 * 60 * 60_000,
    ),
  )
}

export const stopWorker = (): void => {
  for (const timer of timers) clearInterval(timer)
  timers = []
  running = false
}
