import { describe, expect, it } from 'vitest'
import { mapPool } from '../src/pool.js'

describe('mapPool', () => {
  it('caps how many tasks run at once and preserves order', async () => {
    let active = 0
    let peak = 0
    const results = await mapPool([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active -= 1
      return value * 10
    })
    expect(results).toEqual([10, 20, 30, 40, 50])
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBe(2)
  })
})
