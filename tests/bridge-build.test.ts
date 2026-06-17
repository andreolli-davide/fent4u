// tests/bridge-build.test.ts
import { test, expect } from 'bun:test'
import { buildContract, type BuildCtx } from '../src/coordination/bridge.js'
import type { Mission } from '../src/mission/kinds.js'
import type { Grid } from '../src/planning/astar.js'
import type { ParcelBelief } from '../src/blackboard/beliefs.js'
import type { GridTile } from '../src/planning/astar.js'

// 6x3 grid, delivery at (4,1); walkable elsewhere — enough for bindHandoff to find drop+vacate+approach.
function grid(): Grid {
  const tiles = new Map<string, GridTile>()
  for (let x = 0; x <= 5; x++) for (let y = 0; y <= 2; y++) tiles.set(`${x},${y}`, { type: 'walkable' })
  tiles.set('4,1', { type: 'delivery' })
  return { w: 6, h: 3, tiles, deliveryZones: [{ x: 4, y: 1 }] }
}
function coord(contractType: string, params: Partial<Mission['params']> = {}): Mission {
  return { id: 'm1', kind: 'COORDINATION_CONTRACT', payoff: 200, abstractIntent: 'x', params: { contractType, ...params }, rawText: 'x', status: 'CLASSIFIED' }
}
function parcel(id: string, x: number, y: number, r: number): ParcelBelief {
  return { id, pos: { x, y }, rewardSeen: r, carriedBy: null, lastSeen: 0 }
}
const ctx = (over: Partial<BuildCtx> = {}): BuildCtx => ({
  parcels: [parcel('p1', 0, 0, 100)],
  self: { id: 'liaison', pos: { x: 0, y: 0 } },
  partner: { id: 'courier', pos: { x: 5, y: 2 } },
  isClaimed: () => false,
  tnow: 10,
  ...over,
})

test('buildContract HANDOFF binds parcel, roles, tiles and a deadline', () => {
  const c = buildContract(coord('HANDOFF'), grid(), ctx())!
  expect(c.type).toBe('HANDOFF')
  expect(c.id).toBe('m1:HANDOFF')
  expect(c.lockParcels).toEqual(['p1'])
  expect(c.lockOwner).toBe('liaison')      // closer to p1 at (0,0)
  expect(c.payoff).toBe(200)
  expect(c.deadline).toBe(510)             // tnow 10 + DEFAULT_CONTRACT_TTL 500 (mission has no deadline)
  expect(c.status).toBe('PROPOSED')
})

test('buildContract HANDOFF returns null when no parcel is eligible', () => {
  expect(buildContract(coord('HANDOFF'), grid(), ctx({ parcels: [] }))).toBeNull()
})

test('buildContract HANDOFF returns null when no partner is bound yet', () => {
  expect(buildContract(coord('HANDOFF'), grid(), ctx({ partner: null }))).toBeNull()
})

test('buildContract RENDEZVOUS binds the central delivery zone', () => {
  const c = buildContract(coord('RENDEZVOUS'), grid(), ctx())!
  expect(c.type).toBe('RENDEZVOUS')
  expect(c.id).toBe('m1:RENDEZVOUS')
  expect(c.steps.some((s) => s.kind === 'LOCAL' && s.goal.kind === 'IN_ZONE')).toBe(true)
})

test('buildContract uses an explicit mission deadline when present', () => {
  const m = coord('RENDEZVOUS'); m.deadline = 999
  expect(buildContract(m, grid(), ctx())!.deadline).toBe(999)
})

test('buildContract returns null for an unknown contractType', () => {
  expect(buildContract(coord('NONSENSE'), grid(), ctx())).toBeNull()
})

test('buildContract SYNC_GATE binds a staging zone and no locks', () => {
  const c = buildContract(coord('SYNC_GATE'), grid(), ctx())!
  expect(c.type).toBe('SYNC_GATE')
  expect(c.id).toBe('m1:SYNC_GATE')
  expect(c.lockParcels).toBeUndefined()
  expect(c.steps.some((s) => s.kind === 'BARRIER')).toBe(true)
})

test('buildContract SYNC_GATE returns null with no target (no TEXT_BOUND, no zones)', () => {
  const emptyGrid: Grid = { w: 6, h: 3, tiles: new Map(), deliveryZones: [] }
  expect(buildContract(coord('SYNC_GATE'), emptyGrid, ctx())).toBeNull()
})
