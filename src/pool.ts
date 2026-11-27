export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('concurrency must be an integer >= 1')
  }
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      const item = items[index]
      if (item === undefined && index >= items.length) return
      results[index] = await fn(item as T, index)
    }
  })
  await Promise.all(workers)
  return results
}
