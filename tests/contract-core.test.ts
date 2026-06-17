// tests/contract-core.test.ts
import { test, expect } from 'bun:test'
import { goalSatisfied, navTarget } from '../src/coordination/contract.js'

test('AT_TILE goal is satisfied only on the exact tile', () => {
  const goal = { kind: 'AT_TILE' as const, tile: { x: 3, y: 2 } }
  expect(goalSatisfied(goal, { x: 3, y: 2 })).toBe(true)
  expect(goalSatisfied(goal, { x: 3, y: 1 })).toBe(false)
})

test('IN_ZONE goal uses Manhattan radius (server metric, §8.4)', () => {
  const goal = { kind: 'IN_ZONE' as const, center: { x: 5, y: 5 }, radius: 3 }
  expect(goalSatisfied(goal, { x: 5, y: 5 })).toBe(true)  // d=0
  expect(goalSatisfied(goal, { x: 7, y: 6 })).toBe(true)  // d=3
  expect(goalSatisfied(goal, { x: 8, y: 6 })).toBe(false) // d=4
})

test('navTarget returns the tile for AT_TILE and the centre for IN_ZONE', () => {
  expect(navTarget({ kind: 'AT_TILE', tile: { x: 1, y: 2 } })).toEqual({ x: 1, y: 2 })
  expect(navTarget({ kind: 'IN_ZONE', center: { x: 4, y: 4 }, radius: 2 })).toEqual({ x: 4, y: 4 })
})
