/**
 * Runs `task` over `items` with at most `limit` in flight at once, and
 * returns the results in the order of `items`. Shared by the analysis
 * pipeline's chunks and the expiry sweep's documents (#170).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let cursor = 0

  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await task(items[index], index)
      }
    }
  )

  await Promise.all(workers)
  return results
}
