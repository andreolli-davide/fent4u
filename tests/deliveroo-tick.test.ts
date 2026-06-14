// tests/deliveroo-tick.test.ts
import { test, expect } from 'bun:test'
import { tickFrom } from '../src/external/deliveroo.js'

test('tickFrom returns the anchor frame when no time has elapsed', () => {
  expect(tickFrom(100, 1000, 1000, 50)).toBe(100)
})

test('tickFrom adds floor(elapsed / clock) frames', () => {
  // 500 ms elapsed at 50 ms/frame = 10 frames
  expect(tickFrom(100, 1000, 1500, 50)).toBe(110)
})

test('tickFrom floors a partial frame', () => {
  // 70 ms elapsed = 1.4 frames -> floor 1
  expect(tickFrom(100, 1000, 1070, 50)).toBe(101)
})

test('tickFrom handles the exact frame boundary', () => {
  // 50 ms elapsed = exactly 1 frame
  expect(tickFrom(0, 0, 50, 50)).toBe(1)
})

test('tickFrom pre-first-ping case: anchorFrame 0 grows from connect time', () => {
  // before first ping, anchorFrame=0, anchorWallMs=connect time
  expect(tickFrom(0, 2000, 2200, 50)).toBe(4) // 200ms / 50 = 4
})
