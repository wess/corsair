// A slow batch still owns its concurrency slots when the next timer fires.
export const poll = (label: string, work: () => Promise<unknown>): (() => Promise<void>) => {
  let busy = false
  return async () => {
    if (busy) return
    busy = true
    try {
      await work()
    } catch (error) {
      console.error(`[corsair] ${label} failed:`, error)
    } finally {
      busy = false
    }
  }
}
