import { describe, expect, test } from "bun:test"

/**
 * The guard exists because one unhandled throw on the delivery path used to take
 * down every listener at once, and systemd restarted straight back into the same
 * message — a loop, not a blip.
 *
 * These run in a **subprocess** rather than in-process. The property under test
 * is "the process is still alive afterwards", which cannot be observed from
 * inside the process that would have died; and `bun test` installs its own
 * unhandled-rejection handling, so an in-process version would be measuring the
 * test runner rather than Corsair.
 */

const GUARD = new URL("../src/resilience/index.ts", import.meta.url).pathname

const run = async (body: string): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(
    [
      "bun",
      "-e",
      `import { installCrashGuards, unhandledCount } from ${JSON.stringify(GUARD)}
       installCrashGuards()
       ${body}
       setTimeout(() => {
         console.log("SURVIVED count=" + unhandledCount())
         process.exit(0)
       }, 250)`,
    ],
    { stdout: "pipe", stderr: "pipe" },
  )
  const out = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  return { code: await proc.exited, out: out + err }
}

describe("crash guards", () => {
  test("an unhandled rejection does not kill the process", async () => {
    const { code, out } = await run(`void Promise.reject(new Error("simulated delivery failure"))`)
    expect(out).toContain("SURVIVED count=1")
    expect(out).toContain("simulated delivery failure")
    expect(code).toBe(0)
  }, 20_000)

  test("an uncaught exception does not kill the process", async () => {
    const { code, out } = await run(
      `setTimeout(() => { throw new Error("simulated parse failure") }, 10)`,
    )
    expect(out).toContain("SURVIVED count=1")
    expect(out).toContain("simulated parse failure")
    expect(code).toBe(0)
  }, 20_000)

  test("a thrown non-Error is described rather than dropped", async () => {
    const { code, out } = await run(`void Promise.reject("a bare string, as some libraries throw")`)
    expect(out).toContain("SURVIVED count=1")
    expect(out).toContain("a bare string")
    expect(code).toBe(0)
  }, 20_000)

  test("several failures accumulate rather than resetting", async () => {
    const { out } = await run(`
      void Promise.reject(new Error("one"))
      void Promise.reject(new Error("two"))
      void Promise.reject(new Error("three"))`)
    expect(out).toContain("SURVIVED count=3")
  }, 20_000)

  test("an out-of-memory failure still exits, for a clean restart", async () => {
    const { code, out } = await run(
      `void Promise.reject(new Error("JavaScript heap out of memory"))`,
    )
    expect(out).toContain("fatal — exiting for a clean restart")
    expect(out).not.toContain("SURVIVED")
    expect(code).toBe(1)
  }, 20_000)
})
