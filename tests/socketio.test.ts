import { expect, test } from "bun:test"
import { createReader, createWriter } from "../src/socketio/index.ts"

test("closing a slow socket releases producers and discards queued mail", async () => {
  const writer = createWriter(() => ({ write: () => 0 }))
  writer.write("x".repeat(2 * 1024 * 1024))
  let flushed = false
  writer.afterFlush(() => {
    flushed = true
  })
  const waiting = writer.settled()
  writer.close()
  await waiting
  expect(writer.backlog()).toBe(0)
  expect(flushed).toBe(false)
  writer.write("more")
  expect(writer.backlog()).toBe(0)
})

test("a closed socket's negative write cannot retain a message", () => {
  const writer = createWriter(() => ({ write: () => -1 }))
  writer.write("private message")
  expect(writer.backlog()).toBe(0)
})

test("reader processes packets in order and owns their bytes across awaits", async () => {
  const first = Promise.withResolvers<void>()
  const seen: number[] = []
  let active = 0
  let peak = 0
  const reader = createReader(
    async (chunk) => {
      peak = Math.max(peak, ++active)
      if (!seen.length) await first.promise
      seen.push(chunk[0]!)
      active--
    },
    () => {
      throw new Error("unexpected overflow")
    },
    100,
  )
  const chunk = new Uint8Array([1])
  const one = reader.feed(chunk)
  chunk[0] = 9
  const two = reader.feed(new Uint8Array([2]))
  first.resolve()
  await Promise.all([one, two])
  expect(seen).toEqual([1, 2])
  expect(peak).toBe(1)
})

test("reader caps packets queued behind a stalled command", async () => {
  const waiting = Promise.withResolvers<void>()
  let stopped = 0
  let processed = 0
  const reader = createReader(
    async () => {
      processed++
      await waiting.promise
    },
    () => {
      stopped++
    },
    4,
  )
  const one = reader.feed(new Uint8Array(3))
  await Bun.sleep(1)
  reader.feed(new Uint8Array(3))
  expect(stopped).toBe(1)
  waiting.resolve()
  await one
  await reader.feed(new Uint8Array(1))
  expect(processed).toBe(1)
})
