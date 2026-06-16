// tests/rate-tracker.test.ts
import { test, expect } from 'bun:test'
import { DeliveryRateTracker } from '../src/bdi/rate-tracker.js'

test('returns the bootstrap rate before any sample', () => {
  const t = new DeliveryRateTracker(5, 2)
  expect(t.uForgone()).toBe(2)
  expect(t.rhoRef()).toBe(2)
})

test('first delivery sets the clock but yields no sample', () => {
  const t = new DeliveryRateTracker(5, 2)
  t.record(10, 0) // no prior tick → no rate sample yet
  expect(t.uForgone()).toBe(2) // still bootstrap
})

test('computes reward/tick samples between deliveries', () => {
  const t = new DeliveryRateTracker(5, 0.1)
  t.record(0, 0)   // clock = 0
  t.record(10, 5)  // 10 pts over 5 ticks → 2.0
  t.record(20, 15) // 20 pts over 10 ticks → 2.0
  expect(t.uForgone()).toBeCloseTo(2.0, 6) // mean of [2,2]
  expect(t.rhoRef()).toBeCloseTo(2.0, 6)   // p90 of [2,2]
})

test('rhoRef is the nearest-rank 90th percentile, uForgone the mean', () => {
  const t = new DeliveryRateTracker(10, 0)
  let tick = 0
  t.record(0, tick)
  for (let i = 0; i < 8; i++) { tick += 1; t.record(1, tick) } // eight rate-1 samples
  for (let i = 0; i < 2; i++) { tick += 1; t.record(10, tick) } // two rate-10 samples
  // 10 samples sorted = [1×8, 10, 10]; p90 nearest-rank index = ceil(0.9·10) − 1 = 8 → 10.
  expect(t.rhoRef()).toBe(10)
  expect(t.uForgone()).toBeCloseTo((8 * 1 + 2 * 10) / 10, 6) // mean = 2.8
  expect(t.rhoRef()).toBeGreaterThan(t.uForgone())            // p90 sits above the mean
})

test('window evicts old samples (FIFO)', () => {
  const t = new DeliveryRateTracker(2, 0)
  t.record(0, 0)
  t.record(2, 1)  // rate 2
  t.record(2, 2)  // rate 2
  t.record(100, 3) // rate 100 — window holds only the last 2 samples [2, 100]
  expect(t.uForgone()).toBeCloseTo(51, 6)
})
