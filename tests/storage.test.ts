import { expect, test } from "bun:test"

test("object storage preserves mail through copies, moves, and failed writes", async () => {
  // A separate process keeps the test bucket out of the other suites' config.
  const child = Bun.spawn([process.execPath, "test", "./tests/support/storage.ts"], {
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect(code, stdout + stderr).toBe(0)
}, 30_000)
