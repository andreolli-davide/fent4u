import { test, expect } from 'bun:test'
import { buildGrid, planPath, isPushAdmissible, type PlanCtx, type Obstacles } from '../src/planning/astar.js'
import type { Tile } from '../src/types/perception.js'

// 'S'=slide (type-5), '.'=walkable, '#'=wall
function parse(rows: string[]): Tile[] {
  const tiles: Tile[] = []
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const pos = { x, y }
      if (ch === '#') tiles.push({ pos, type: 'wall' })
      else if (ch === 'S') tiles.push({ pos, type: 'slide' })
      else tiles.push({ pos, type: 'walkable' })
    }),
  )
  return tiles
}

function ctxWith(crateAt: Obstacles['crateAt'], protectedTiles = [] as { x: number; y: number }[]): PlanCtx {
  return { obstacles: { crateAt, agentAt: new Set() }, protectedTiles, budgetMs: 50 }
}

test('admissible push opens a path: crate at (1,0) pushed right onto slide (2,0)', () => {
  // row: walkable, crate-on-walkable, slide. Pushing the crate right slides it onto (2,0).
  const grid = buildGrid(parse(['..S']))
  const ctx = ctxWith(new Map([['1,0', { id: 'c1', locked: false }]]))
  const r = planPath(grid, ctx, { x: 0, y: 0 }, { x: 1, y: 0 })
  expect(r.reachable).toBe(true)
  expect(r.firstStep).toEqual({ kind: 'push', dir: 'right', crateId: 'c1' })
  expect(r.pushes).toEqual([{ crateId: 'c1', from: { x: 1, y: 0 }, to: { x: 2, y: 0 }, tickOffset: 0 }])
})

test('push refused when the tile beyond is not type-5', () => {
  const grid = buildGrid(parse(['...'])) // (2,0) is walkable, not a slide
  const ctx = ctxWith(new Map([['1,0', { id: 'c1', locked: false }]]))
  const r = planPath(grid, ctx, { x: 0, y: 0 }, { x: 1, y: 0 })
  expect(r.reachable).toBe(false) // crate blocks, no admissible push
})

test('push refused when the crate is locked', () => {
  const grid = buildGrid(parse(['..S']))
  const ctx = ctxWith(new Map([['1,0', { id: 'c1', locked: true }]]))
  expect(planPath(grid, ctx, { x: 0, y: 0 }, { x: 1, y: 0 }).reachable).toBe(false)
})

test('cratesAsWalls fallback ignores push edges', () => {
  const grid = buildGrid(parse(['..S']))
  const ctx = ctxWith(new Map([['1,0', { id: 'c1', locked: false }]]))
  ctx.cratesAsWalls = true
  expect(planPath(grid, ctx, { x: 0, y: 0 }, { x: 1, y: 0 }).reachable).toBe(false)
})

test('a push that lands the crate on the goal does not falsely report it reachable', () => {
  // '..S': agent (0,0), crate (1,0), slide (2,0). Goal = (2,0).
  // Pushing the crate right puts it ON (2,0); (3,0) is off-grid so it cannot be
  // shoved further. The agent reaches (1,0) but never (2,0) — the crate sits there.
  // The old pos-only search "walked through" the just-pushed crate and lied reachable.
  const grid = buildGrid(parse(['..S']))
  const ctx = ctxWith(new Map([['1,0', { id: 'c1', locked: false }]]))
  const r = planPath(grid, ctx, { x: 0, y: 0 }, { x: 2, y: 0 })
  expect(r.reachable).toBe(false)
})

test('a crate can be pushed off the goal to reach it', () => {
  // 'S..' backwards: goal (0,0), crate on it, slide beyond. Approaching from (1,0)
  // pushes the crate off the goal onto (2,0)... build the mirror: crate on goal,
  // agent at (1,0), slide at (2,0). Pushing right frees (0,0)? No — push is along
  // travel dir. Agent at (1,0) moving left onto crate at (0,0) needs slide at (-1,0):
  // off-grid, so instead place agent right of crate. 'S c .' => crate (1,0) on goal,
  // slide (0,0) is the push target, agent (2,0) pushes left.
  const grid = buildGrid(parse(['S..']))
  const ctx = ctxWith(new Map([['1,0', { id: 'c1', locked: false }]]))
  // goal is the crate's tile (1,0); agent (2,0) pushes it left onto slide (0,0),
  // then steps onto (1,0). blockedCell must block (0,0), never the goal.
  const r = planPath(grid, ctx, { x: 2, y: 0 }, { x: 1, y: 0 })
  expect(r.reachable).toBe(true)
  expect(r.firstStep).toEqual({ kind: 'push', dir: 'left', crateId: 'c1' })
})

test('isPushAdmissible mirrors the planner check', () => {
  const grid = buildGrid(parse(['..S']))
  const ctx = ctxWith(new Map([['1,0', { id: 'c1', locked: false }]]))
  expect(isPushAdmissible(grid, ctx, { x: 1, y: 0 }, 'right')).toBe(true)
  expect(isPushAdmissible(grid, ctx, { x: 1, y: 0 }, 'up')).toBe(false) // off-grid beyond
})
