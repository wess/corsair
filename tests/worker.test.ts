import { expect, spyOn, test } from "bun:test"
import { poll } from "../src/worker/poll/index.ts"

test("slow batches keep their concurrency slots across timer ticks", async () => {
  const pending = Promise.withResolvers<void>()
  let batches = 0
  const run = poll("test", async () => {
    batches++
    await pending.promise
  })
  const first = run()
  await Promise.all(Array.from({ length: 100 }, () => run()))
  expect(batches).toBe(1)
  pending.resolve()
  await first
  await run()
  expect(batches).toBe(2)
})

test("a failed batch releases its slots and reports the failure", async () => {
  const error = new Error("test failure")
  const logged = spyOn(console, "error").mockImplementation(() => {})
  let batches = 0
  const run = poll("test", async () => {
    if (++batches === 1) throw error
  })
  try {
    await run()
    await run()
    expect(batches).toBe(2)
    expect(logged).toHaveBeenCalledWith("[corsair] test failed:", error)
  } finally {
    logged.mockRestore()
  }
})
