import { test, expect } from 'bun:test'
import { buildGrid, planPath, d, type PlanCtx } from '../src/planning/astar.js'
import type { Tile } from '../src/types/perception.js'

function parse(rows: string[]): Tile[] {
  const tiles: Tile[] = []
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const pos = { x, y }
      if (ch === '#') tiles.push({ pos, type: 'wall' })
      else if (ch === 'D') tiles.push({ pos, type: 'delivery' })
      else if (ch === '>') tiles.push({ pos, type: 'oneway', dir: 'right' })
      else tiles.push({ pos, type: 'walkable' })
    }),
  )
  return tiles
}

const emptyCtx: PlanCtx = { obstacles: { crateAt: new Map(), agentAt: new Set() }, protectedTiles: [], budgetMs: 8 }

test('straight-line distance on an open row', () => {
  const grid = buildGrid(parse(['.....']))
  expect(d(grid, emptyCtx, { x: 0, y: 0 }, { x: 4, y: 0 })).toBe(4)
})

test('walls force a detour', () => {
  const grid = buildGrid(parse(['...', '.#.', '...']))
  expect(d(grid, emptyCtx, { x: 0, y: 0 }, { x: 2, y: 2 })).toBe(4)
})

test('unreachable goal returns Infinity', () => {
  const grid = buildGrid(parse(['.#.']))
  expect(d(grid, emptyCtx, { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(Infinity)
})

test('one-way edge is directed', () => {
  const grid = buildGrid(parse(['.>.']))
  expect(d(grid, emptyCtx, { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(2)
  expect(d(grid, emptyCtx, { x: 2, y: 0 }, { x: 0, y: 0 })).toBe(Infinity)
})

// GAME_RULES §Directional: a one-way tile blocks entry only AGAINST its arrow.
// A '>' tile must still admit perpendicular entry (from above/below). Regression
// for the inverted check that allowed only entry in the arrow's exact direction.
test('one-way admits perpendicular entry, blocks only the opposite', () => {
  const grid = buildGrid(parse(['#>#', '...']))
  // (0,1) -> (1,1) -> (1,0): the only route reaches the '>' tile by moving across it.
  expect(d(grid, emptyCtx, { x: 0, y: 1 }, { x: 1, y: 0 })).toBe(2)
})

test('first step points toward the goal', () => {
  const grid = buildGrid(parse(['...']))
  const r = planPath(grid, emptyCtx, { x: 0, y: 0 }, { x: 2, y: 0 })
  expect(r.firstStep).toEqual({ kind: 'move', dir: 'right' })
})

// Server convention (GAME_RULES.md §Movement): up = dy +1, down = dy -1.
// Pins the direction strings we emit to the server's y-axis so a planner that is
// internally consistent but inverted relative to the wire is caught here.
test('vertical first step matches server up/down convention', () => {
  const grid = buildGrid(parse(['.', '.']))
  expect(planPath(grid, emptyCtx, { x: 0, y: 0 }, { x: 0, y: 1 }).firstStep).toEqual({ kind: 'move', dir: 'up' })
  expect(planPath(grid, emptyCtx, { x: 0, y: 1 }, { x: 0, y: 0 }).firstStep).toEqual({ kind: 'move', dir: 'down' })
})

test('crate tile is impassable (crates-as-walls baseline)', () => {
  const grid = buildGrid(parse(['...']))
  const ctx: PlanCtx = {
    obstacles: { crateAt: new Map([['1,0', { id: 'c1', locked: false }]]), agentAt: new Set() },
    protectedTiles: [],
    budgetMs: 8,
  }
  expect(d(grid, ctx, { x: 0, y: 0 }, { x: 2, y: 0 })).toBe(Infinity)
})
