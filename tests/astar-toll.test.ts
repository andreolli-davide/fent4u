import { test, expect } from 'bun:test'
import { buildGrid, planPath, key, type PlanCtx } from '../src/planning/astar.js'
import type { Tile } from '../src/types/perception.js'

function row(n: number): Tile[] {
  const tiles: Tile[] = []
  for (let x = 0; x < n; x++) tiles.push({ pos: { x, y: 0 }, type: 'walkable' })
  return tiles
}
const base = (extra: Partial<PlanCtx> = {}): PlanCtx => ({
  obstacles: { crateAt: new Map(), agentAt: new Set() }, protectedTiles: [], budgetMs: 8, ...extra,
})

test('no tolls: tollSum is 0 and path is the pure-tick shortest', () => {
  const grid = buildGrid(row(5))
  const r = planPath(grid, base(), { x: 0, y: 0 }, { x: 4, y: 0 })
  expect(r.L).toBe(4)
  expect(r.tollSum).toBe(0)
})

test('toll mode accumulates tollSum along the chosen straight path', () => {
  const grid = buildGrid(row(5))
  const ctx = base({ tolls: new Map([[key({ x: 2, y: 0 }), 7]]), cTick: 100 })
  const r = planPath(grid, ctx, { x: 0, y: 0 }, { x: 4, y: 0 })
  expect(r.L).toBe(4)      // L stays a pure tick count (§7.1 rule b)
  expect(r.tollSum).toBe(7)
})

test('toll mode dodges a priced tile when the detour is cheaper in cost units', () => {
  const grid = buildGrid([
    { pos: { x: 0, y: 0 }, type: 'walkable' }, { pos: { x: 1, y: 0 }, type: 'walkable' }, { pos: { x: 2, y: 0 }, type: 'walkable' },
    { pos: { x: 0, y: 1 }, type: 'walkable' }, { pos: { x: 1, y: 1 }, type: 'walkable' }, { pos: { x: 2, y: 1 }, type: 'walkable' },
  ])
  const ctx = base({ tolls: new Map([[key({ x: 1, y: 0 }), 50]]), cTick: 1 })
  const r = planPath(grid, ctx, { x: 0, y: 0 }, { x: 2, y: 0 })
  expect(r.tollSum).toBe(0)  // dodged the toll
  expect(r.L).toBe(4)        // 0,0 -> 0,1 -> 1,1 -> 2,1 -> 2,0  (4 ticks vs 2 straight)
})
