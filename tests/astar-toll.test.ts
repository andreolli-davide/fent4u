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

test('break-even cost tie: result is deterministic and internally consistent', () => {
  // 3×2 grid: (0,0)-(2,0) on row 0, (0,1)-(2,1) on row 1.
  // Direct path (0,0)->(1,0)->(2,0): 2 steps, crosses tolled tile (1,0).
  //   cost = cTick*2 + toll = 25*2 + 50 = 100
  // Detour (0,0)->(0,1)->(1,1)->(2,1)->(2,0): 4 steps, no toll.
  //   cost = cTick*4 = 25*4 = 100
  // Both routes have equal total cost → tie. The planner must be deterministic.
  const grid = buildGrid([
    { pos: { x: 0, y: 0 }, type: 'walkable' }, { pos: { x: 1, y: 0 }, type: 'walkable' }, { pos: { x: 2, y: 0 }, type: 'walkable' },
    { pos: { x: 0, y: 1 }, type: 'walkable' }, { pos: { x: 1, y: 1 }, type: 'walkable' }, { pos: { x: 2, y: 1 }, type: 'walkable' },
  ])
  const ctx = base({ tolls: new Map([[key({ x: 1, y: 0 }), 50]]), cTick: 25 })
  const r1 = planPath(grid, ctx, { x: 0, y: 0 }, { x: 2, y: 0 })
  const r2 = planPath(grid, ctx, { x: 0, y: 0 }, { x: 2, y: 0 })

  // Determinism: two identical calls must return identical results.
  expect(r1.L).toBe(r2.L)
  expect(r1.tollSum).toBe(r2.tollSum)
  expect(r1.firstStep).toEqual(r2.firstStep)

  // Internal consistency: whichever branch the planner chose, L and tollSum must agree.
  const direct = r1.tollSum === 50 && r1.L === 2
  const detour = r1.tollSum === 0 && r1.L === 4
  expect(direct || detour).toBe(true)
})
