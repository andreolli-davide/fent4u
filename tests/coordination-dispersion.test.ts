import { test, expect } from 'bun:test'
import { awayFromPartner } from '../src/coordination/dispersion.js'
import type { Pos } from '../src/types/perception.js'

const manhattan = (a: Pos, b: Pos): number => Math.abs(a.x - b.x) + Math.abs(a.y - b.y)

test('0 at the partner target, rising toward 1 with distance, capped at 1', () => {
  const target: Pos = { x: 0, y: 0 }
  const Dref = 10
  expect(awayFromPartner({ x: 0, y: 0 }, target, Dref, manhattan)).toBe(0)
  expect(awayFromPartner({ x: 5, y: 0 }, target, Dref, manhattan)).toBeCloseTo(0.5, 10)
  expect(awayFromPartner({ x: 50, y: 0 }, target, Dref, manhattan)).toBe(1) // capped
})

test('no partner target → neutral 0 (degraded mode handles region ownership elsewhere)', () => {
  expect(awayFromPartner({ x: 5, y: 0 }, null, 10, manhattan)).toBe(0)
})
