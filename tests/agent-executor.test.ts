import { test, expect } from 'bun:test'
import {
  manhattan, goalOf, worldSignature, revalidateStep, progressed, blockingTile, freshCursor,
} from '../src/mission/agent/executor.js'
import { buildGrid } from '../src/planning/astar.js'
import type { PlanCtx } from '../src/planning/astar.js'
import type { WorldSnapshot } from '../src/mission/agent/snapshot.js'
import type { AgentStep, Mission } from '../src/mission/kinds.js'
import type { Tile } from '../src/types/perception.js'

// 3x1 walkable row, delivery at (0,0).
const map: Tile[] = [
  { pos: { x: 0, y: 0 }, type: 'delivery' },
  { pos: { x: 1, y: 0 }, type: 'walkable' },
  { pos: { x: 2, y: 0 }, type: 'walkable' },
]
const grid = buildGrid(map)
const ctx: PlanCtx = { obstacles: { crateAt: new Map(), agentAt: new Set() }, protectedTiles: [], budgetMs: 8 }

const snap = (over: Partial<WorldSnapshot> = {}): WorldSnapshot => ({
  t0: 0, selfPos: { x: 2, y: 0 }, carried: [], delivered: [],
  parcels: [{ id: 'p1', pos: { x: 1, y: 0 }, reward: 10, carriedBy: null }],
  zones: [{ x: 0, y: 0 }], partnerPos: null, sig: 'x', ...over,
})

const plan = (steps: AgentStep[]) => ({ steps, L: 4, vPlan: 5 })
const mission = (steps: AgentStep[]): Mission => ({
  kind: 'AGENT_PLAN', payoff: 10, abstractIntent: 'x', params: {},
  id: 'm1', rawText: 'go', status: 'CLASSIFIED', plan: plan(steps),
})

test('manhattan + goalOf resolve each op', () => {
  expect(manhattan({ x: 0, y: 0 }, { x: 2, y: 0 })).toBe(2)
  expect(goalOf({ op: 'goto', target: { x: 1, y: 0 } }, snap())).toEqual({ x: 1, y: 0 })
  expect(goalOf({ op: 'pickup', parcelId: 'p1' }, snap())).toEqual({ x: 1, y: 0 })
  expect(goalOf({ op: 'deliver', zone: { x: 0, y: 0 } }, snap())).toEqual({ x: 0, y: 0 })
  expect(goalOf({ op: 'wait', n: 3 }, snap())).toBeNull()
})

test('worldSignature ignores self and plan-target parcels', () => {
  const p = plan([{ op: 'pickup', parcelId: 'p1' }])
  const a = worldSignature(snap({ selfPos: { x: 2, y: 0 } }), p)
  const b = worldSignature(snap({ selfPos: { x: 0, y: 0 } }), p) // self moved
  const c = worldSignature(snap({ parcels: [{ id: 'p1', pos: { x: 1, y: 0 }, reward: 10, carriedBy: 'self' }] }), p) // target picked
  expect(a).toBe(b)
  expect(a).toBe(c)
  // a NON-target parcel appearing DOES change the signature.
  const d = worldSignature(snap({ parcels: [
    { id: 'p1', pos: { x: 1, y: 0 }, reward: 10, carriedBy: null },
    { id: 'p2', pos: { x: 2, y: 0 }, reward: 5, carriedBy: null },
  ] }), p)
  expect(d).not.toBe(a)
})

test('revalidateStep flags each invalid case', () => {
  expect(revalidateStep({ op: 'goto', target: { x: 1, y: 0 } }, snap(), grid, ctx)).toBe('ok')
  // unreachable target (off-map) → invalid
  expect(revalidateStep({ op: 'goto', target: { x: 9, y: 9 } }, snap(), grid, ctx)).toBe('invalid')
  expect(revalidateStep({ op: 'pickup', parcelId: 'p1' }, snap(), grid, ctx)).toBe('ok')
  expect(revalidateStep({ op: 'pickup', parcelId: 'gone' }, snap(), grid, ctx)).toBe('invalid')
  const taken = snap({ parcels: [{ id: 'p1', pos: { x: 1, y: 0 }, reward: 10, carriedBy: 'enemy' }] })
  expect(revalidateStep({ op: 'pickup', parcelId: 'p1' }, taken, grid, ctx)).toBe('invalid')
  expect(revalidateStep({ op: 'deliver', zone: { x: 0, y: 0 } }, snap(), grid, ctx)).toBe('ok')
  expect(revalidateStep({ op: 'deliver', zone: { x: 1, y: 0 } }, snap(), grid, ctx)).toBe('invalid') // not a delivery tile
  expect(revalidateStep({ op: 'wait', n: 2 }, snap(), grid, ctx)).toBe('ok')
})

test('progressed: ptr advance, distance shrink, or wait-tick all count', () => {
  expect(progressed(true, 5, 5, false)).toBe(true)   // ptr advanced
  expect(progressed(false, 5, 4, false)).toBe(true)  // distance shrank
  expect(progressed(false, 5, 5, true)).toBe(true)   // wait tick
  expect(progressed(false, 5, 5, false)).toBe(false) // stalled
  expect(progressed(false, 5, 6, false)).toBe(false) // moved away
})

test('blockingTile returns the first planned tile toward the goal', () => {
  // self (2,0) -> goal (0,0): first step is left to (1,0).
  expect(blockingTile({ x: 2, y: 0 }, { x: 0, y: 0 }, grid, ctx)).toEqual({ x: 1, y: 0 })
  // already at goal → null
  expect(blockingTile({ x: 0, y: 0 }, { x: 0, y: 0 }, grid, ctx)).toBeNull()
})

test('freshCursor seeds ptr 0, zeroed counters, dist to first goal', () => {
  const c = freshCursor(mission([{ op: 'goto', target: { x: 0, y: 0 } }]), 'sig', snap())
  expect(c).toMatchObject({ missionId: 'm1', ptr: 0, sigAtLanding: 'sig', ticksNoProgress: 0, blockedCount: 0, waitLeft: null })
  expect(c.lastDist).toBe(2) // (2,0)->(0,0)
  expect(c.lastSelfPos).toEqual({ x: 2, y: 0 })
})
